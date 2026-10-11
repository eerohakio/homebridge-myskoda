# homebridge-myskoda

Homebridge plugin for Škoda vehicles, built on the official
[MyŠkoda Public API](https://public.api.connect.skoda-auto.cz/docs) (v1,
API-key based). It does not use the legacy unofficial app API
(`mysmob.api.connect.skoda-auto.cz`, username/password login) that Škoda is
retiring.

It exposes per vehicle:

| HomeKit service | What it does |
| --- | --- |
| **Switch** “Charging” | Start / stop charging (`POST …/charging/start`, `…/charging/stop`) |
| **Battery** | State of charge, charging state, low battery below 20 % |
| **Thermostat** “Air Conditioning” | Off / Auto starts or stops climatisation; target temperature in °C (16–30, 0.5 steps) |
| **Thermostat** “Auxiliary Heating” | Off / Heat starts or stops the auxiliary heater (needs S-PIN); target temperature in °C |

Services are only added when the vehicle reports the matching operation
(`startCharging`, `startAirConditioning`, `startAuxiliaryHeating`), and each can
be turned off in the config.

## Requirements

- Homebridge 1.8+ or 2.x, Node.js 20, 22 or 24
- An API key from the MyŠkoda app: **Profile → Smart Home → Create key**, with
  the vehicles you want to control selected. Keys expire; the log warns a week
  before.
- The VIN of each vehicle (the API has no vehicle list endpoint).
- For auxiliary heating: your S-PIN.

## Configuration

Use the Homebridge UI, or add to `config.json`:

```json
{
  "platform": "MySkoda",
  "name": "MySkoda",
  "apiKey": "YOUR-API-KEY",
  "pollIntervalMinutes": 15,
  "vehicles": [
    {
      "vin": "TMBJJ7NY0PF000001",
      "name": "Enyaq",
      "spin": "1234",
      "defaultTargetTemperature": 21,
      "airConditioningWithoutExternalPower": true,
      "auxiliaryHeatingDurationMinutes": 30
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | — | MyŠkoda Public API key (required) |
| `pollIntervalMinutes` | `15` | Status refresh interval, minimum 5 |
| `useSandbox` | `false` | Use `public.test-api.connect.skoda-auto.cz` |
| `vehicles[].vin` | — | 17-character VIN (required) |
| `vehicles[].name` | `Škoda <last 6 of VIN>` | Accessory name |
| `vehicles[].spin` | — | S-PIN; auxiliary heating is hidden without it |
| `vehicles[].defaultTargetTemperature` | `21` | °C used until you pick one or the car reports one |
| `vehicles[].exposeCharging` / `exposeBattery` / `exposeAirConditioning` / `exposeAuxiliaryHeating` | `true` | Hide individual services |
| `vehicles[].airConditioningWithoutExternalPower` | not sent | Allow climatisation on battery when unplugged |
| `vehicles[].auxiliaryHeatingDurationMinutes` | not sent | Heater run time; vehicle setting if empty |

## How it behaves

- **Target temperature.** The API has no separate “set temperature” command; the
  target is sent with the start command. Changing it while the A/C or heater is
  off just stores it for the next start. Changing it while running restarts the
  climatisation with the new target, after a 2-second debounce so dragging the
  slider sends one request.
- **Current temperature.** The API doesn't report cabin temperature, so the
  thermostats show the target temperature as the current one.
- **Rate limit.** The API allows about 20 requests per hour per vehicle, commands
  included. The plugin polls every 15 minutes by default, refreshes once 45 s
  after each command, and backs off on HTTP 429 using `Retry-After`.
- **Command feedback.** Commands are accepted asynchronously (HTTP 202). HomeKit
  shows the requested state for up to 3 minutes or until the car confirms it.
  If the API rejects a command (e.g. not plugged in), HomeKit shows “No Response”
  for that action and the switch returns to the real state.

## Development

```sh
npm install
npm test          # unit tests (vitest)
npm run typecheck
npm run build     # compiles to dist/
```

Run it in a local Homebridge with `npx homebridge -D -I -P .`.

Not affiliated with or endorsed by Škoda Auto.
