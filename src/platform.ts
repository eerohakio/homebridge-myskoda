import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { VehicleAccessory, type AccessoryContext } from './accessory.js';
import { MySkodaClient, PRODUCTION_BASE_URL, SANDBOX_BASE_URL } from './api.js';
import { VehiclePoller } from './poller.js';
import {
  DEFAULT_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type MySkodaPlatformConfig,
  type VehicleConfig,
} from './settings.js';
import { detectCapabilities, type Capabilities } from './state.js';

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export class MySkodaPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly pollers: VehiclePoller[] = [];
  private readonly config: MySkodaPlatformConfig;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.config = config as MySkodaPlatformConfig;
    api.on('didFinishLaunching', () => this.setup());
    api.on('shutdown', () => this.pollers.forEach((p) => p.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private setup(): void {
    const apiKey = this.config.apiKey?.trim();
    const vehicles = this.validVehicles();
    if (!apiKey) {
      this.log.error('No API key configured. Create one in the MyŠkoda app (Profile → Smart Home).');
    }

    const client = apiKey
      ? new MySkodaClient({ apiKey, baseUrl: this.config.useSandbox ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL })
      : undefined;
    const intervalMinutes = Math.max(
      MIN_POLL_INTERVAL_MINUTES,
      Number(this.config.pollIntervalMinutes) || DEFAULT_POLL_INTERVAL_MINUTES,
    );

    const active = new Set<string>();
    for (const vehicle of client ? vehicles : []) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${vehicle.vin}`);
      active.add(uuid);
      this.setupVehicle(client!, vehicle, uuid, intervalMinutes * 60);
    }

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length > 0 && client) {
      this.log.info(`Removing ${stale.length} vehicle(s) no longer in the config.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private setupVehicle(client: MySkodaClient, config: VehicleConfig, uuid: string, intervalSeconds: number): void {
    const name = config.name?.trim() || `Škoda ${config.vin.slice(-6)}`;
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<AccessoryContext>(name, uuid);
      accessory.context.vin = config.vin;
    }

    const poller = new VehiclePoller(client, config.vin, this.log, intervalSeconds);
    const handler = new VehicleAccessory(this, accessory, config, client, poller);

    // Until the first fetch tells us what the car supports, use what we knew
    // last time (or assume the common EV set for a brand new accessory).
    const fallback: Capabilities = accessory.context.capabilities ?? {
      charging: true,
      battery: true,
      airConditioning: true,
      auxiliaryHeating: Boolean(config.spin),
    };
    handler.configure(fallback);

    let detected = false;
    poller.onUpdate((vehicle) => {
      if (detected) {
        return;
      }
      detected = true;
      const capabilities = detectCapabilities(vehicle);
      this.log.info(
        `[${config.vin}] Supports: ${Object.entries(capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ') || 'nothing controllable'}`,
      );
      handler.configure(capabilities);
      this.api.updatePlatformAccessories([accessory]);
    });

    if (isNew) {
      this.log.info(`Adding vehicle ${name} (${config.vin}).`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }

    this.pollers.push(poller);
    poller.start();
  }

  private validVehicles(): VehicleConfig[] {
    const seen = new Set<string>();
    const result: VehicleConfig[] = [];
    for (const raw of this.config.vehicles ?? []) {
      const vin = String(raw?.vin ?? '').trim().toUpperCase();
      if (!VIN_PATTERN.test(vin)) {
        this.log.error(`Ignoring vehicle with invalid VIN "${raw?.vin ?? ''}" (must be 17 characters).`);
        continue;
      }
      if (seen.has(vin)) {
        this.log.warn(`Ignoring duplicate vehicle ${vin}.`);
        continue;
      }
      seen.add(vin);
      result.push({ ...raw, vin, spin: raw.spin ? String(raw.spin).trim() : undefined });
    }
    if (result.length === 0) {
      this.log.warn('No vehicles configured. Add the VIN of each car to the plugin config.');
    }
    return result;
  }
}
