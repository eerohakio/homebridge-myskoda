import type { Logging } from 'homebridge';

import { MySkodaAuthError, MySkodaRateLimitError, type MySkodaClient, type Vehicle } from './api.js';
import { REFRESH_DELAY_AFTER_COMMAND_SECONDS } from './settings.js';

const AUTH_ERROR_BACKOFF_SECONDS = 3600;

type Listener = (vehicle: Vehicle) => void;

/**
 * Polls one vehicle, respecting the API's rate limit (20 requests/hour per
 * VIN, commands included) and refreshing once shortly after each command.
 */
export class VehiclePoller {
  vehicle?: Vehicle;
  private timer?: NodeJS.Timeout;
  private listeners: Listener[] = [];
  private stopped = false;
  private inFlight?: Promise<void>;
  private lastExpiryWarning = 0;

  constructor(
    private readonly client: MySkodaClient,
    readonly vin: string,
    private readonly log: Logging,
    private readonly intervalSeconds: number,
  ) {}

  onUpdate(listener: Listener): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Schedule a refresh after a command so the new state shows up soon. */
  refreshSoon(): void {
    this.schedule(REFRESH_DELAY_AFTER_COMMAND_SECONDS);
  }

  /** Fetch now. Concurrent calls share one request. */
  refresh(): Promise<void> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    let next = this.intervalSeconds;
    try {
      const { vehicle, errors } = await this.client.getVehicle(this.vin);
      for (const error of errors) {
        this.log.debug(`[${this.vin}] Partial data: ${error.type ?? ''} ${error.description ?? ''}`.trim());
      }
      this.vehicle = vehicle;
      this.logRateLimit();
      for (const listener of this.listeners) {
        try {
          listener(vehicle);
        } catch (error) {
          this.log.error(`[${this.vin}] Failed to apply vehicle state: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      if (error instanceof MySkodaRateLimitError) {
        next = Math.max(error.retryAfterSeconds, this.intervalSeconds);
        this.log.warn(`[${this.vin}] ${error.message}. Next update in ${Math.round(next / 60)} min.`);
      } else if (error instanceof MySkodaAuthError) {
        next = AUTH_ERROR_BACKOFF_SECONDS;
        this.log.error(
          `[${this.vin}] API key rejected (${error.message}). Create a new key in the MyŠkoda app ` +
            '(Profile → Smart Home) with this vehicle selected, and update the plugin config.',
        );
      } else {
        this.log.warn(`[${this.vin}] Could not update vehicle status: ${(error as Error).message}`);
      }
    }
    this.schedule(next);
  }

  private schedule(seconds: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(), seconds * 1000);
    this.timer.unref?.();
  }

  private logRateLimit(): void {
    const { remaining, limit, keyExpiresAt } = this.client.rateLimit;
    if (remaining !== undefined && limit !== undefined) {
      this.log.debug(`[${this.vin}] API requests remaining: ${remaining}/${limit}`);
    }
    if (keyExpiresAt) {
      const days = (keyExpiresAt.getTime() - Date.now()) / 86_400_000;
      if (days < 7 && Date.now() - this.lastExpiryWarning > 86_400_000) {
        this.lastExpiryWarning = Date.now();
        this.log.warn(`API key expires on ${keyExpiresAt.toISOString()}. Create a new one in the MyŠkoda app.`);
      }
    }
  }
}
