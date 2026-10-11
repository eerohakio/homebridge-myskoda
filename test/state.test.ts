import { describe, expect, it } from 'vitest';

import { clampTemperature } from '../src/settings.js';
import {
  auxiliaryHeatingAcceptsTemperature,
  detectCapabilities,
  isAirConditioningActive,
  isAuxiliaryHeatingActive,
  reportedTargetCelsius,
} from '../src/state.js';

describe('detectCapabilities', () => {
  it('uses the operations list when present', () => {
    expect(
      detectCapabilities({
        operations: [{ name: 'startCharging' }, { name: 'startAuxiliaryHeating' }],
        airConditioning: { state: 'OFF' },
        charging: { status: { battery: { stateOfChargeInPercent: 55 } } },
      }),
    ).toEqual({ charging: true, battery: true, airConditioning: false, auxiliaryHeating: true });
  });

  it('falls back to status sections without operations', () => {
    expect(detectCapabilities({ airConditioning: { state: 'OFF' }, auxiliaryHeating: { state: 'UNSUPPORTED' } })).toEqual(
      { charging: false, battery: false, airConditioning: true, auxiliaryHeating: false },
    );
  });
});

describe('state helpers', () => {
  it('detects active climatisation states', () => {
    expect(isAirConditioningActive({ airConditioning: { state: 'HEATING' } })).toBe(true);
    expect(isAirConditioningActive({ airConditioning: { state: 'OFF' } })).toBe(false);
    expect(isAuxiliaryHeatingActive({ auxiliaryHeating: { state: 'HEATING_AUXILIARY' } })).toBe(true);
    expect(isAuxiliaryHeatingActive({ auxiliaryHeating: { state: 'OFF' } })).toBe(false);
  });

  it('converts reported Fahrenheit targets to Celsius', () => {
    expect(
      reportedTargetCelsius({ airConditioning: { targetTemperature: { value: 72, unit: 'FAHRENHEIT' } } }, 'airConditioning'),
    ).toBe(22);
  });

  it('only omits the heater temperature when the car reports heater data without one', () => {
    expect(auxiliaryHeatingAcceptsTemperature({})).toBe(true);
    expect(auxiliaryHeatingAcceptsTemperature({ auxiliaryHeating: { state: 'OFF' } })).toBe(false);
    expect(
      auxiliaryHeatingAcceptsTemperature({ auxiliaryHeating: { targetTemperature: { value: 22, unit: 'CELSIUS' } } }),
    ).toBe(true);
  });

  it('clamps and rounds temperatures to 0.5 °C within 16–30', () => {
    expect(clampTemperature(21.3)).toBe(21.5);
    expect(clampTemperature(10)).toBe(16);
    expect(clampTemperature(35)).toBe(30);
  });
});
