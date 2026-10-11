import type { PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { MySkodaClient, Vehicle } from './api.js';
import type { MySkodaPlatform } from './platform.js';
import type { VehiclePoller } from './poller.js';
import {
  DEFAULT_TARGET_TEMPERATURE,
  LOW_BATTERY_PERCENT,
  MAX_TARGET_TEMPERATURE,
  MIN_TARGET_TEMPERATURE,
  PENDING_STATE_TTL_SECONDS,
  TARGET_TEMPERATURE_STEP,
  TEMPERATURE_DEBOUNCE_MS,
  clampTemperature,
  type VehicleConfig,
} from './settings.js';
import {
  airConditioningState,
  auxiliaryHeatingAcceptsTemperature,
  isAirConditioningActive,
  isAuxiliaryHeatingActive,
  isCharging,
  reportedTargetCelsius,
  stateOfCharge,
  type Capabilities,
} from './state.js';

export interface AccessoryContext {
  vin: string;
  capabilities?: Capabilities;
  airConditioningTarget?: number;
  auxiliaryHeatingTarget?: number;
}

type Control = 'charging' | 'airConditioning' | 'auxiliaryHeating';

const SUBTYPE = {
  charging: 'charging',
  battery: 'battery',
  airConditioning: 'air-conditioning',
  auxiliaryHeating: 'auxiliary-heating',
} as const;

/**
 * One HomeKit accessory per vehicle with:
 *  - Switch "Charging" (start/stop charging)
 *  - Battery (state of charge, charging state)
 *  - Thermostat "Air Conditioning" (on/off + target °C)
 *  - Thermostat "Auxiliary Heating" (on/off + target °C, needs S-PIN)
 */
export class VehicleAccessory {
  private readonly hap;
  private readonly pending = new Map<Control, { on: boolean; until: number }>();
  private readonly debounceTimers = new Map<Control, NodeJS.Timeout>();

  private chargingService?: Service;
  private batteryService?: Service;
  private airConditioningService?: Service;
  private auxiliaryHeatingService?: Service;

  constructor(
    private readonly platform: MySkodaPlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
    private readonly config: VehicleConfig,
    private readonly client: MySkodaClient,
    private readonly poller: VehiclePoller,
  ) {
    this.hap = platform.api.hap;
    const { Characteristic, Service } = this.hap;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Škoda')
      .setCharacteristic(Characteristic.Model, 'MyŠkoda vehicle')
      .setCharacteristic(Characteristic.SerialNumber, config.vin);

    poller.onUpdate((vehicle) => this.update(vehicle));
  }

  private get log() {
    return this.platform.log;
  }

  private get vin(): string {
    return this.config.vin;
  }

  private get vehicle(): Vehicle {
    return this.poller.vehicle ?? {};
  }

  /** Add or remove services to match what the vehicle supports. */
  configure(capabilities: Capabilities): void {
    this.accessory.context.capabilities = capabilities;
    const name = this.accessory.displayName;

    this.chargingService = this.toggleService(
      capabilities.charging && this.config.exposeCharging !== false,
      SUBTYPE.charging,
      () => this.createChargingService(`${name} Charging`),
    );
    this.batteryService = this.toggleService(
      capabilities.battery && this.config.exposeBattery !== false,
      SUBTYPE.battery,
      () => this.createBatteryService(`${name} Battery`),
    );
    this.airConditioningService = this.toggleService(
      capabilities.airConditioning && this.config.exposeAirConditioning !== false,
      SUBTYPE.airConditioning,
      () => this.createThermostat('airConditioning', `${name} Air Conditioning`),
    );

    let auxiliaryHeating = capabilities.auxiliaryHeating && this.config.exposeAuxiliaryHeating !== false;
    if (auxiliaryHeating && !this.config.spin) {
      this.log.warn(`[${this.vin}] Auxiliary heating is supported but no S-PIN is configured; not exposing it.`);
      auxiliaryHeating = false;
    }
    this.auxiliaryHeatingService = this.toggleService(auxiliaryHeating, SUBTYPE.auxiliaryHeating, () =>
      this.createThermostat('auxiliaryHeating', `${name} Auxiliary Heating`),
    );

    if (this.poller.vehicle) {
      this.update(this.poller.vehicle);
    }
  }

  /** Remove a disabled service; otherwise (re)attach handlers to the cached or a new one. */
  private toggleService(enabled: boolean, subtype: string, setup: () => Service): Service | undefined {
    if (!enabled) {
      const existing = this.accessory.services.find((s) => s.subtype === subtype);
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    return setup();
  }

  private getOrAddService(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const existing = this.accessory.getServiceById(type, subtype);
    if (existing) {
      return existing;
    }
    const service = this.accessory.addService(type, name, subtype);
    const { Characteristic } = this.hap;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }

  // ---------------------------------------------------------------------------
  // Charging
  // ---------------------------------------------------------------------------

  private createChargingService(name: string): Service {
    const { Characteristic, Service } = this.hap;
    const service = this.getOrAddService(Service.Switch, name, SUBTYPE.charging);
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.isOn('charging'))
      .onSet(async (value) => {
        const on = Boolean(value);
        await this.run('charging', on, () =>
          on ? this.client.startCharging(this.vin) : this.client.stopCharging(this.vin),
        );
      });
    return service;
  }

  private createBatteryService(name: string): Service {
    const { Characteristic, Service } = this.hap;
    const service = this.getOrAddService(Service.Battery, name, SUBTYPE.battery);
    service.getCharacteristic(Characteristic.BatteryLevel).onGet(() => stateOfCharge(this.vehicle) ?? 0);
    service.getCharacteristic(Characteristic.ChargingState).onGet(() => this.chargingState());
    service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.lowBattery());
    return service;
  }

  private chargingState(): number {
    const { ChargingState } = this.hap.Characteristic;
    if (this.isOn('charging')) {
      return ChargingState.CHARGING;
    }
    return ChargingState.NOT_CHARGING;
  }

  private lowBattery(): number {
    const { StatusLowBattery } = this.hap.Characteristic;
    const soc = stateOfCharge(this.vehicle);
    return soc !== undefined && soc < LOW_BATTERY_PERCENT
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  // ---------------------------------------------------------------------------
  // Air conditioning / auxiliary heating (Thermostat, Celsius)
  // ---------------------------------------------------------------------------

  private createThermostat(control: 'airConditioning' | 'auxiliaryHeating', name: string): Service {
    const { Characteristic, Service } = this.hap;
    const service = this.getOrAddService(Service.Thermostat, name, SUBTYPE[control]);

    const onMode =
      control === 'airConditioning'
        ? Characteristic.TargetHeatingCoolingState.AUTO
        : Characteristic.TargetHeatingCoolingState.HEAT;

    service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.OFF, onMode] })
      .onGet(() => (this.isOn(control) ? onMode : Characteristic.TargetHeatingCoolingState.OFF))
      .onSet(async (value) => {
        const on = value !== Characteristic.TargetHeatingCoolingState.OFF;
        await this.run(control, on, () => (on ? this.startClimate(control) : this.stopClimate(control)));
      });

    service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentHeatingCoolingState(control));

    service
      .getCharacteristic(Characteristic.TargetTemperature)
      // HAP's default (10 °C) is below our minimum; set a valid value first.
      .updateValue(this.targetTemperature(control))
      .setProps({
        minValue: MIN_TARGET_TEMPERATURE,
        maxValue: MAX_TARGET_TEMPERATURE,
        minStep: TARGET_TEMPERATURE_STEP,
      })
      .onGet(() => this.targetTemperature(control))
      .onSet((value) => this.setTargetTemperature(control, Number(value)));

    // The API doesn't report cabin temperature; mirror the target so HomeKit
    // has a sensible value to show.
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.targetTemperature(control));

    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setProps({ validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => undefined);

    return service;
  }

  private targetTemperature(control: 'airConditioning' | 'auxiliaryHeating'): number {
    const key = control === 'airConditioning' ? 'airConditioningTarget' : 'auxiliaryHeatingTarget';
    const value =
      this.accessory.context[key] ??
      reportedTargetCelsius(this.vehicle, control) ??
      this.config.defaultTargetTemperature ??
      DEFAULT_TARGET_TEMPERATURE;
    return clampTemperature(value);
  }

  private setTargetTemperature(control: 'airConditioning' | 'auxiliaryHeating', value: number): void {
    const key = control === 'airConditioning' ? 'airConditioningTarget' : 'auxiliaryHeatingTarget';
    const celsius = clampTemperature(value);
    this.accessory.context[key] = celsius;
    this.platform.api.updatePlatformAccessories([this.accessory]);

    // The API has no "set temperature" command; the target is sent with the
    // start command. If it's already running, restart with the new target.
    clearTimeout(this.debounceTimers.get(control));
    if (!this.isOn(control)) {
      this.log.info(`[${this.vin}] ${label(control)} target set to ${celsius} °C (applied on next start).`);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(control);
      this.log.info(`[${this.vin}] Restarting ${label(control).toLowerCase()} with target ${celsius} °C.`);
      this.run(control, true, () => this.startClimate(control)).catch(() => undefined);
    }, TEMPERATURE_DEBOUNCE_MS);
    this.debounceTimers.set(control, timer);
  }

  private startClimate(control: 'airConditioning' | 'auxiliaryHeating'): Promise<void> {
    const target = this.targetTemperature(control);
    if (control === 'airConditioning') {
      return this.client.startAirConditioning(this.vin, {
        targetTemperatureCelsius: target,
        withoutExternalPower: this.config.airConditioningWithoutExternalPower,
      });
    }
    const minutes = this.config.auxiliaryHeatingDurationMinutes;
    return this.client.startAuxiliaryHeating(this.vin, {
      spin: this.config.spin ?? '',
      targetTemperatureCelsius: auxiliaryHeatingAcceptsTemperature(this.vehicle) ? target : undefined,
      durationInSeconds: minutes ? minutes * 60 : undefined,
    });
  }

  private stopClimate(control: 'airConditioning' | 'auxiliaryHeating'): Promise<void> {
    return control === 'airConditioning'
      ? this.client.stopAirConditioning(this.vin)
      : this.client.stopAuxiliaryHeating(this.vin);
  }

  private currentHeatingCoolingState(control: 'airConditioning' | 'auxiliaryHeating'): number {
    const { CurrentHeatingCoolingState } = this.hap.Characteristic;
    if (!this.isOn(control)) {
      return CurrentHeatingCoolingState.OFF;
    }
    if (control === 'airConditioning') {
      const state = airConditioningState(this.vehicle);
      if (state === 'COOLING' || state === 'VENTILATION') {
        return CurrentHeatingCoolingState.COOL;
      }
    }
    return CurrentHeatingCoolingState.HEAT;
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  /** Current on/off state; a recent command wins over (possibly stale) polled data. */
  private isOn(control: Control): boolean {
    const pending = this.pending.get(control);
    if (pending) {
      if (Date.now() < pending.until) {
        return pending.on;
      }
      this.pending.delete(control);
    }
    switch (control) {
      case 'charging':
        return isCharging(this.vehicle);
      case 'airConditioning':
        return isAirConditioningActive(this.vehicle);
      case 'auxiliaryHeating':
        return isAuxiliaryHeatingActive(this.vehicle);
    }
  }

  private async run(control: Control, on: boolean, command: () => Promise<void>): Promise<void> {
    const action = `${on ? 'start' : 'stop'} ${label(control).toLowerCase()}`;
    try {
      await command();
      this.log.info(`[${this.vin}] Requested ${action}.`);
      this.pending.set(control, { on, until: Date.now() + PENDING_STATE_TTL_SECONDS * 1000 });
      this.poller.refreshSoon();
    } catch (error) {
      this.log.error(`[${this.vin}] Failed to ${action}: ${(error as Error).message}`);
      // Push the real state back to HomeKit once this handler has returned.
      setImmediate(() => this.update(this.vehicle));
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Push polled state to HomeKit. */
  update(vehicle: Vehicle): void {
    const { Characteristic } = this.hap;

    // Drop optimistic state once the vehicle confirms it.
    for (const [control, pending] of this.pending) {
      const actual =
        control === 'charging'
          ? isCharging(vehicle)
          : control === 'airConditioning'
            ? isAirConditioningActive(vehicle)
            : isAuxiliaryHeatingActive(vehicle);
      if (actual === pending.on) {
        this.pending.delete(control);
      }
    }

    this.chargingService?.updateCharacteristic(Characteristic.On, this.isOn('charging'));

    if (this.batteryService) {
      const soc = stateOfCharge(vehicle);
      if (soc !== undefined) {
        this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, soc);
      }
      this.batteryService.updateCharacteristic(Characteristic.ChargingState, this.chargingState());
      this.batteryService.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery());
    }

    for (const control of ['airConditioning', 'auxiliaryHeating'] as const) {
      const service = control === 'airConditioning' ? this.airConditioningService : this.auxiliaryHeatingService;
      if (!service) {
        continue;
      }
      const onMode =
        control === 'airConditioning'
          ? Characteristic.TargetHeatingCoolingState.AUTO
          : Characteristic.TargetHeatingCoolingState.HEAT;
      const target = this.targetTemperature(control);
      service.updateCharacteristic(
        Characteristic.TargetHeatingCoolingState,
        this.isOn(control) ? onMode : Characteristic.TargetHeatingCoolingState.OFF,
      );
      service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState(control));
      service.updateCharacteristic(Characteristic.TargetTemperature, target);
      service.updateCharacteristic(Characteristic.CurrentTemperature, target);
    }
  }
}

function label(control: Control): string {
  switch (control) {
    case 'charging':
      return 'Charging';
    case 'airConditioning':
      return 'Air conditioning';
    case 'auxiliaryHeating':
      return 'Auxiliary heating';
  }
}

