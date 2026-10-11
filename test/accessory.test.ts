import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VehicleAccessory, type AccessoryContext } from '../src/accessory.js';
import type { MySkodaClient, Vehicle } from '../src/api.js';
import type { MySkodaPlatform } from '../src/platform.js';
import type { VehiclePoller } from '../src/poller.js';

const { Characteristic, Service } = hap;
const VIN = 'TMBJJ7NY0PF000001';

const ALL = { charging: true, battery: true, airConditioning: true, auxiliaryHeating: true };

function setup(vehicle: Vehicle, config: Record<string, unknown> = {}) {
  const listeners: ((v: Vehicle) => void)[] = [];
  const poller = {
    vehicle,
    onUpdate: (l: (v: Vehicle) => void) => listeners.push(l),
    refreshSoon: vi.fn(),
  };
  const client = {
    startCharging: vi.fn(async () => undefined),
    stopCharging: vi.fn(async () => undefined),
    startAirConditioning: vi.fn(async () => undefined),
    stopAirConditioning: vi.fn(async () => undefined),
    startAuxiliaryHeating: vi.fn(async () => undefined),
    stopAuxiliaryHeating: vi.fn(async () => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = {
    log,
    api: { hap, updatePlatformAccessories: vi.fn() } as unknown as API,
  } as unknown as MySkodaPlatform;

  const accessory = new hap.Accessory('Enyaq', hap.uuid.generate(VIN)) as unknown as PlatformAccessory<AccessoryContext>;
  Object.assign(accessory, { context: { vin: VIN } });

  const handler = new VehicleAccessory(
    platform,
    accessory,
    { vin: VIN, spin: '1234', ...config },
    client as unknown as MySkodaClient,
    poller as unknown as VehiclePoller,
  );
  const push = (v: Vehicle) => {
    poller.vehicle = v;
    listeners.forEach((l) => l(v));
  };
  return { accessory, handler, client, poller, push, log };
}

function service(accessory: PlatformAccessory, type: typeof Service.Switch, subtype: string) {
  const s = accessory.getServiceById(type, subtype);
  expect(s).toBeDefined();
  return s!;
}

async function set(s: hap.Service, c: typeof Characteristic.On, value: hap.CharacteristicValue) {
  await s.getCharacteristic(c).handleSetRequest(value);
}

describe('VehicleAccessory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exposes services for supported controls only', () => {
    const { accessory, handler } = setup({});
    handler.configure({ ...ALL, auxiliaryHeating: false });
    expect(accessory.getServiceById(Service.Switch, 'charging')).toBeDefined();
    expect(accessory.getServiceById(Service.Battery, 'battery')).toBeDefined();
    expect(accessory.getServiceById(Service.Thermostat, 'air-conditioning')).toBeDefined();
    expect(accessory.getServiceById(Service.Thermostat, 'auxiliary-heating')).toBeUndefined();

    handler.configure({ ...ALL, charging: false });
    expect(accessory.getServiceById(Service.Switch, 'charging')).toBeUndefined();
    expect(accessory.getServiceById(Service.Thermostat, 'auxiliary-heating')).toBeDefined();
  });

  it('hides auxiliary heating without an S-PIN', () => {
    const { accessory, handler, log } = setup({}, { spin: undefined });
    handler.configure(ALL);
    expect(accessory.getServiceById(Service.Thermostat, 'auxiliary-heating')).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('starts and stops charging from the switch', async () => {
    const { accessory, handler, client, poller } = setup({ charging: { status: { state: 'READY_FOR_CHARGING' } } });
    handler.configure(ALL);
    const sw = service(accessory, Service.Switch, 'charging');

    await set(sw, Characteristic.On, true);
    expect(client.startCharging).toHaveBeenCalledWith(VIN);
    expect(poller.refreshSoon).toHaveBeenCalled();
    // Optimistic state until the car confirms.
    expect(await sw.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true);

    await set(sw, Characteristic.On, false);
    expect(client.stopCharging).toHaveBeenCalledWith(VIN);
  });

  it('starts air conditioning with the target temperature in Celsius', async () => {
    const { accessory, handler, client } = setup({ airConditioning: { state: 'OFF' } }, { airConditioningWithoutExternalPower: true });
    handler.configure(ALL);
    const ac = service(accessory, Service.Thermostat, 'air-conditioning');

    await set(ac, Characteristic.TargetTemperature, 23.5);
    expect(client.startAirConditioning).not.toHaveBeenCalled();

    await set(ac, Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.AUTO);
    expect(client.startAirConditioning).toHaveBeenCalledWith(VIN, {
      targetTemperatureCelsius: 23.5,
      withoutExternalPower: true,
    });
    expect(ac.getCharacteristic(Characteristic.TemperatureDisplayUnits).value).toBe(
      Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    await set(ac, Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
    expect(client.stopAirConditioning).toHaveBeenCalledWith(VIN);
  });

  it('restarts running air conditioning once after temperature changes settle', async () => {
    const { accessory, handler, client } = setup({ airConditioning: { state: 'HEATING' } });
    handler.configure(ALL);
    const ac = service(accessory, Service.Thermostat, 'air-conditioning');

    await set(ac, Characteristic.TargetTemperature, 20);
    await set(ac, Characteristic.TargetTemperature, 21);
    await set(ac, Characteristic.TargetTemperature, 22);
    expect(client.startAirConditioning).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500);
    expect(client.startAirConditioning).toHaveBeenCalledTimes(1);
    expect(client.startAirConditioning).toHaveBeenCalledWith(VIN, expect.objectContaining({ targetTemperatureCelsius: 22 }));
  });

  it('starts auxiliary heating with S-PIN, Celsius target and duration', async () => {
    const { accessory, handler, client } = setup(
      { auxiliaryHeating: { state: 'OFF', targetTemperature: { value: 22, unit: 'CELSIUS' } } },
      { auxiliaryHeatingDurationMinutes: 30 },
    );
    handler.configure(ALL);
    const heater = service(accessory, Service.Thermostat, 'auxiliary-heating');
    expect(await heater.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()).toBe(22);

    await set(heater, Characteristic.TargetTemperature, 25);
    await set(heater, Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.HEAT);
    expect(client.startAuxiliaryHeating).toHaveBeenCalledWith(VIN, {
      spin: '1234',
      targetTemperatureCelsius: 25,
      durationInSeconds: 1800,
    });
    expect(await heater.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(
      Characteristic.CurrentHeatingCoolingState.HEAT,
    );
  });

  it('reports a communication failure and keeps the real state when a command fails', async () => {
    const { accessory, handler, client } = setup({ charging: { status: { state: 'READY_FOR_CHARGING' } } });
    handler.configure(ALL);
    client.startCharging.mockRejectedValueOnce(new Error('Not plugged in'));
    const sw = service(accessory, Service.Switch, 'charging');

    await expect(set(sw, Characteristic.On, true)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(await sw.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false);
  });

  it('updates characteristics from polled data', () => {
    const { accessory, handler, push } = setup({});
    handler.configure(ALL);
    push({
      charging: { status: { state: 'CHARGING', battery: { stateOfChargeInPercent: 15 } } },
      airConditioning: { state: 'COOLING', targetTemperature: { value: 19, unit: 'CELSIUS' } },
    });

    const battery = service(accessory, Service.Battery, 'battery');
    expect(battery.getCharacteristic(Characteristic.BatteryLevel).value).toBe(15);
    expect(battery.getCharacteristic(Characteristic.ChargingState).value).toBe(Characteristic.ChargingState.CHARGING);
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    expect(service(accessory, Service.Switch, 'charging').getCharacteristic(Characteristic.On).value).toBe(true);

    const ac = service(accessory, Service.Thermostat, 'air-conditioning');
    expect(ac.getCharacteristic(Characteristic.TargetTemperature).value).toBe(19);
    expect(ac.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value).toBe(
      Characteristic.CurrentHeatingCoolingState.COOL,
    );
  });
});
