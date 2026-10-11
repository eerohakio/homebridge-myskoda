import type { Vehicle } from './api.js';

/** Which controls a vehicle supports. Persisted in the accessory context. */
export interface Capabilities {
  charging: boolean;
  battery: boolean;
  airConditioning: boolean;
  auxiliaryHeating: boolean;
}

const AIR_CONDITIONING_ACTIVE = new Set(['ON', 'COOLING', 'HEATING', 'HEATING_AUXILIARY', 'VENTILATION', 'DEFROSTING']);
const AUXILIARY_HEATING_ACTIVE = new Set(['ON', 'HEATING', 'PREHEATING', 'HEATING_AUXILIARY', 'VENTILATION']);
const INACTIVE_STATES = new Set([undefined, '', 'UNKNOWN', 'UNSUPPORTED', 'INVALID']);

export function operationNames(vehicle: Vehicle): Set<string> {
  const names = new Set<string>();
  for (const op of vehicle.operations ?? []) {
    if (op && typeof op.name === 'string') {
      names.add(op.name);
    }
  }
  return names;
}

/**
 * Derive supported controls from vehicle data. The `operations` list is
 * authoritative when present; otherwise fall back to which status sections
 * the API returned.
 */
export function detectCapabilities(vehicle: Vehicle): Capabilities {
  const ops = operationNames(vehicle);
  const hasOps = ops.size > 0;
  const battery = vehicle.charging?.status?.battery?.stateOfChargeInPercent !== undefined;
  return {
    charging: hasOps ? ops.has('startCharging') : vehicle.charging !== undefined,
    battery,
    airConditioning: hasOps ? ops.has('startAirConditioning') : vehicle.airConditioning !== undefined,
    auxiliaryHeating: hasOps
      ? ops.has('startAuxiliaryHeating')
      : !INACTIVE_STATES.has(vehicle.auxiliaryHeating?.state),
  };
}

export function isCharging(vehicle: Vehicle): boolean {
  return vehicle.charging?.status?.state === 'CHARGING';
}

export function isPluggedIn(vehicle: Vehicle): boolean | undefined {
  const plug = vehicle.charging?.status?.plugConnectionState;
  if (plug === undefined) {
    return undefined;
  }
  return plug === 'CONNECTED';
}

export function stateOfCharge(vehicle: Vehicle): number | undefined {
  const soc = vehicle.charging?.status?.battery?.stateOfChargeInPercent;
  return typeof soc === 'number' ? Math.min(100, Math.max(0, Math.round(soc))) : undefined;
}

export function airConditioningState(vehicle: Vehicle): string | undefined {
  return vehicle.airConditioning?.state;
}

export function isAirConditioningActive(vehicle: Vehicle): boolean {
  return AIR_CONDITIONING_ACTIVE.has(vehicle.airConditioning?.state ?? '');
}

export function isAuxiliaryHeatingActive(vehicle: Vehicle): boolean {
  return AUXILIARY_HEATING_ACTIVE.has(vehicle.auxiliaryHeating?.state ?? '');
}

/** Target temperature reported by the vehicle, converted to °C. */
export function reportedTargetCelsius(
  vehicle: Vehicle,
  section: 'airConditioning' | 'auxiliaryHeating',
): number | undefined {
  const target = vehicle[section]?.targetTemperature;
  if (!target || typeof target.value !== 'number') {
    return undefined;
  }
  if (target.unit === 'FAHRENHEIT') {
    return Math.round((((target.value - 32) * 5) / 9) * 2) / 2;
  }
  return target.value;
}

/**
 * Whether to include a target temperature when starting auxiliary heating.
 * Some (fuel-fired) heaters don't take one; only skip it when the vehicle
 * reports auxiliary heating data without a target temperature.
 */
export function auxiliaryHeatingAcceptsTemperature(vehicle: Vehicle): boolean {
  const aux = vehicle.auxiliaryHeating;
  return aux === undefined || aux.targetTemperature !== undefined;
}
