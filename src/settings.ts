import type { PlatformConfig } from 'homebridge';

export const PLATFORM_NAME = 'MySkoda';
export const PLUGIN_NAME = 'homebridge-myskoda';

export const DEFAULT_POLL_INTERVAL_MINUTES = 15;
export const MIN_POLL_INTERVAL_MINUTES = 5;
export const REFRESH_DELAY_AFTER_COMMAND_SECONDS = 45;
/** How long an optimistic state set by a command wins over polled data. */
export const PENDING_STATE_TTL_SECONDS = 180;
/** Debounce for target temperature changes (the Home app slider sends many). */
export const TEMPERATURE_DEBOUNCE_MS = 2000;

export const MIN_TARGET_TEMPERATURE = 16;
export const MAX_TARGET_TEMPERATURE = 30;
export const TARGET_TEMPERATURE_STEP = 0.5;
export const DEFAULT_TARGET_TEMPERATURE = 21;
export const LOW_BATTERY_PERCENT = 20;

export interface VehicleConfig {
  vin: string;
  name?: string;
  spin?: string;
  exposeCharging?: boolean;
  exposeAirConditioning?: boolean;
  exposeAuxiliaryHeating?: boolean;
  exposeBattery?: boolean;
  airConditioningWithoutExternalPower?: boolean;
  auxiliaryHeatingDurationMinutes?: number;
  defaultTargetTemperature?: number;
}

export interface MySkodaPlatformConfig extends PlatformConfig {
  apiKey?: string;
  useSandbox?: boolean;
  pollIntervalMinutes?: number;
  vehicles?: VehicleConfig[];
}

export function clampTemperature(value: number): number {
  const stepped = Math.round(value / TARGET_TEMPERATURE_STEP) * TARGET_TEMPERATURE_STEP;
  return Math.min(MAX_TARGET_TEMPERATURE, Math.max(MIN_TARGET_TEMPERATURE, stepped));
}
