/**
 * Minimal client for the official MyŠkoda Public API v1
 * (https://public.api.connect.skoda-auto.cz/docs), launched in 2026.
 *
 * This is not the legacy, unofficial app API (mysmob.api.connect.skoda-auto.cz
 * with username/password login), which Škoda is shutting down.
 *
 * Authentication is a per-account API key created in the MyŠkoda app
 * (Profile → Smart Home), sent in the `X-API-Key` header. Commands are
 * accepted asynchronously (HTTP 202); the new state shows up on a later
 * `GET /api/v1/vehicles/{vin}`.
 */

export const PRODUCTION_BASE_URL = 'https://public.api.connect.skoda-auto.cz';
export const SANDBOX_BASE_URL = 'https://public.test-api.connect.skoda-auto.cz';

const PROBLEM_PREFIX = '/problems/';
const DEFAULT_RETRY_AFTER_SECONDS = 900;
const MAX_RETRY_AFTER_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 60_000;

export type TemperatureUnit = 'CELSIUS' | 'FAHRENHEIT';

export interface Temperature {
  value: number;
  unit: TemperatureUnit;
}

export interface VehicleOperation {
  name?: string;
  [key: string]: unknown;
}

export interface ChargingStatus {
  state?: string;
  chargeType?: string;
  chargePowerInKw?: number;
  remainingTimeToFullyChargedInMinutes?: number;
  plugConnectionState?: string;
  battery?: {
    stateOfChargeInPercent?: number;
    remainingCruisingRangeInMeters?: number;
  };
}

export interface Vehicle {
  vin?: string;
  name?: string;
  licensePlate?: string;
  operations?: VehicleOperation[];
  charging?: {
    status?: ChargingStatus;
    settings?: {
      targetStateOfChargeInPercent?: number;
    };
  };
  airConditioning?: {
    state?: string;
    targetTemperature?: Temperature;
    airConditioningWithoutExternalPower?: boolean;
    estimatedReachOfTargetTemperatureAt?: string;
  };
  auxiliaryHeating?: {
    state?: string;
    targetTemperature?: Temperature;
    durationInSeconds?: number;
  };
  [key: string]: unknown;
}

export interface VehicleResponse {
  vehicle: Vehicle;
  errors: { type?: string; description?: string }[];
}

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  keyExpiresAt?: Date;
}

export class MySkodaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly problem?: string,
  ) {
    super(message);
    this.name = 'MySkodaApiError';
  }
}

/** API key expired, revoked or not bound to this vehicle (401/403). */
export class MySkodaAuthError extends MySkodaApiError {
  override name = 'MySkodaAuthError';
}

/** The vehicle refused or cannot perform the command (403 operation-not-authorized, 422). */
export class MySkodaOperationError extends MySkodaApiError {
  override name = 'MySkodaOperationError';
}

/** Rate limit hit (429) or service unavailable (503). */
export class MySkodaRateLimitError extends MySkodaApiError {
  override name = 'MySkodaRateLimitError';
  constructor(
    message: string,
    status: number,
    readonly retryAfterSeconds: number,
    problem?: string,
  ) {
    super(message, status, problem);
  }
}

export interface AirConditioningStartOptions {
  targetTemperatureCelsius?: number;
  withoutExternalPower?: boolean;
}

export interface AuxiliaryHeatingStartOptions {
  spin: string;
  targetTemperatureCelsius?: number;
  durationInSeconds?: number;
}

export interface MySkodaClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class MySkodaClient {
  readonly baseUrl: string;
  readonly rateLimit: RateLimitInfo = {};
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MySkodaClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async getVehicle(vin: string): Promise<VehicleResponse> {
    const data = (await this.request('GET', this.vehiclePath(vin))) as Partial<VehicleResponse> | undefined;
    return {
      vehicle: data?.vehicle ?? {},
      errors: data?.errors ?? [],
    };
  }

  startCharging(vin: string): Promise<void> {
    return this.command(vin, 'POST', 'charging/start');
  }

  stopCharging(vin: string): Promise<void> {
    return this.command(vin, 'POST', 'charging/stop');
  }

  startAirConditioning(vin: string, options: AirConditioningStartOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {};
    if (options.targetTemperatureCelsius !== undefined) {
      body.targetTemperature = celsius(options.targetTemperatureCelsius);
    }
    if (options.withoutExternalPower !== undefined) {
      body.airConditioningWithoutExternalPower = options.withoutExternalPower;
    }
    return this.command(vin, 'POST', 'air-conditioning/start', body);
  }

  stopAirConditioning(vin: string): Promise<void> {
    return this.command(vin, 'POST', 'air-conditioning/stop');
  }

  startAuxiliaryHeating(vin: string, options: AuxiliaryHeatingStartOptions): Promise<void> {
    const body: Record<string, unknown> = { spin: options.spin, startMode: 'HEATING' };
    if (options.targetTemperatureCelsius !== undefined) {
      body.targetTemperature = celsius(options.targetTemperatureCelsius);
    }
    if (options.durationInSeconds !== undefined) {
      body.durationInSeconds = Math.round(options.durationInSeconds);
    }
    return this.command(vin, 'POST', 'auxiliary-heating/start', body);
  }

  stopAuxiliaryHeating(vin: string): Promise<void> {
    return this.command(vin, 'POST', 'auxiliary-heating/stop');
  }

  private vehiclePath(vin: string): string {
    return `/api/v1/vehicles/${encodeURIComponent(vin.trim().toUpperCase())}`;
  }

  private async command(vin: string, method: string, suffix: string, body?: Record<string, unknown>): Promise<void> {
    await this.request(method, `${this.vehiclePath(vin)}/${suffix}`, body);
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MySkodaApiError(`Request to MyŠkoda API failed: ${(error as Error).message}`);
    }

    this.updateRateLimit(response.headers);

    if (response.ok) {
      if (response.status === 200 && isJson(response.headers)) {
        return response.json();
      }
      return undefined;
    }

    throw await toError(response);
  }

  private updateRateLimit(headers: Headers): void {
    const limit = toInt(headers.get('RateLimit-Limit'));
    const remaining = toInt(headers.get('RateLimit-Remaining'));
    const reset = toInt(headers.get('RateLimit-Reset'));
    const expires = headers.get('X-API-Key-Expires-At');
    if (limit !== undefined) {
      this.rateLimit.limit = limit;
    }
    if (remaining !== undefined) {
      this.rateLimit.remaining = remaining;
    }
    if (reset !== undefined) {
      this.rateLimit.resetSeconds = reset;
    }
    if (expires) {
      const date = new Date(expires);
      if (!Number.isNaN(date.getTime())) {
        this.rateLimit.keyExpiresAt = date;
      }
    }
  }
}

function celsius(value: number): Temperature {
  return { value, unit: 'CELSIUS' };
}

function isJson(headers: Headers): boolean {
  const type = headers.get('Content-Type') ?? '';
  return type.includes('json');
}

function toInt(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function toError(response: Response): Promise<MySkodaApiError> {
  let problem: { type?: string; title?: string; detail?: string } = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') {
      problem = parsed as typeof problem;
    }
  } catch {
    // Body is not JSON; fall back to the status code.
  }

  const type = typeof problem.type === 'string' ? problem.type : '';
  const index = type.indexOf(PROBLEM_PREFIX);
  const short = index >= 0 ? type.slice(index + PROBLEM_PREFIX.length) : undefined;
  const status = response.status;
  const detail = problem.detail || problem.title || `HTTP ${status}`;

  switch (status) {
    case 401:
      return new MySkodaAuthError(detail, status, short ?? 'unauthorized');
    case 403:
      return short === 'operation-not-authorized'
        ? new MySkodaOperationError(detail, status, short)
        : new MySkodaAuthError(detail, status, short ?? 'forbidden');
    case 404:
      return new MySkodaApiError(`Vehicle not found: ${detail}`, status, short);
    case 422:
      return new MySkodaOperationError(detail, status, short);
    case 429:
    case 503: {
      const retryAfter = Math.min(
        Math.max(toInt(response.headers.get('Retry-After')) ?? DEFAULT_RETRY_AFTER_SECONDS, 1),
        MAX_RETRY_AFTER_SECONDS,
      );
      const message = status === 429 ? `Rate limit reached: ${detail}` : `Service unavailable: ${detail}`;
      return new MySkodaRateLimitError(message, status, retryAfter, short);
    }
    default:
      return new MySkodaApiError(`${status}: ${detail}`, status, short);
  }
}
