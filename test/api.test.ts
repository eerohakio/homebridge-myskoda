import { describe, expect, it, vi } from 'vitest';

import {
  MySkodaAuthError,
  MySkodaClient,
  MySkodaOperationError,
  MySkodaRateLimitError,
} from '../src/api.js';

const VIN = 'TMBJJ7NY0PF000001';

function mockFetch(status = 202, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    }),
  );
}

function client(fetch: ReturnType<typeof mockFetch>) {
  return new MySkodaClient({ apiKey: 'secret', fetch: fetch as unknown as typeof globalThis.fetch });
}

function call(fetch: ReturnType<typeof mockFetch>) {
  const [url, init] = fetch.mock.calls[0]!;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

describe('MySkodaClient', () => {
  it('fetches vehicle status with the API key header', async () => {
    const fetch = mockFetch(200, { vehicle: { vin: VIN, charging: { status: { state: 'CHARGING' } } } }, {
      'RateLimit-Limit': '20',
      'RateLimit-Remaining': '17',
      'X-API-Key-Expires-At': '2027-01-01T00:00:00Z',
    });
    const api = client(fetch);
    const result = await api.getVehicle(VIN.toLowerCase());

    const req = call(fetch);
    expect(req.url).toBe(`https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${VIN}`);
    expect(req.method).toBe('GET');
    expect(req.headers['X-API-Key']).toBe('secret');
    expect(result.vehicle.charging?.status?.state).toBe('CHARGING');
    expect(api.rateLimit).toMatchObject({ limit: 20, remaining: 17 });
    expect(api.rateLimit.keyExpiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it.each([
    ['startCharging', 'charging/start'],
    ['stopCharging', 'charging/stop'],
    ['stopAirConditioning', 'air-conditioning/stop'],
    ['stopAuxiliaryHeating', 'auxiliary-heating/stop'],
  ] as const)('%s posts to %s without a body', async (method, suffix) => {
    const fetch = mockFetch();
    await client(fetch)[method](VIN);
    const req = call(fetch);
    expect(req.method).toBe('POST');
    expect(req.url.endsWith(`/api/v1/vehicles/${VIN}/${suffix}`)).toBe(true);
    expect(req.body).toBeUndefined();
  });

  it('starts air conditioning with a Celsius target', async () => {
    const fetch = mockFetch();
    await client(fetch).startAirConditioning(VIN, { targetTemperatureCelsius: 22.5, withoutExternalPower: true });
    const req = call(fetch);
    expect(req.url.endsWith('/air-conditioning/start')).toBe(true);
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({
      targetTemperature: { value: 22.5, unit: 'CELSIUS' },
      airConditioningWithoutExternalPower: true,
    });
  });

  it('starts auxiliary heating with S-PIN, Celsius target and duration', async () => {
    const fetch = mockFetch();
    await client(fetch).startAuxiliaryHeating(VIN, {
      spin: '1234',
      targetTemperatureCelsius: 23,
      durationInSeconds: 1800,
    });
    expect(call(fetch).body).toEqual({
      spin: '1234',
      targetTemperature: { value: 23, unit: 'CELSIUS' },
      durationInSeconds: 1800,
    });
  });

  it('maps 401 to an auth error', async () => {
    const fetch = mockFetch(401, { type: 'https://public.api.connect.skoda-auto.cz/problems/unauthorized', detail: 'Key expired' });
    await expect(client(fetch).getVehicle(VIN)).rejects.toBeInstanceOf(MySkodaAuthError);
  });

  it('maps 403 operation-not-authorized and 422 to operation errors', async () => {
    const forbidden = mockFetch(403, { type: 'https://public.api.connect.skoda-auto.cz/problems/operation-not-authorized' });
    await expect(client(forbidden).startCharging(VIN)).rejects.toBeInstanceOf(MySkodaOperationError);
    const unprocessable = mockFetch(422, { title: 'Not plugged in' });
    await expect(client(unprocessable).startCharging(VIN)).rejects.toThrow('Not plugged in');
  });

  it('maps 429 to a rate limit error with Retry-After', async () => {
    const fetch = mockFetch(429, { title: 'Too many requests' }, { 'Retry-After': '120' });
    const error = await client(fetch).getVehicle(VIN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MySkodaRateLimitError);
    expect((error as MySkodaRateLimitError).retryAfterSeconds).toBe(120);
  });
});
