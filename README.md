<p align="center">
  <img src="docs/images/logo.png" alt="Car Heater Card" width="180">
</p>

# Car Heater Card

A Lovelace custom card for the Home Assistant **Car Heater** integration.

## Features

- Shows departure, start, stop and run time in one panel
- Temperature and temperature source display
- Optional power bar
- Start now and stop controls
- Manual/workday departure time picker
- Swedish and English translations
- Visual editor support
- Automatic entity detection from the Car Heater device
- HACS frontend compatible

## Installation with HACS

1. Open HACS.
2. Go to **Frontend**.
3. Add this repository as a custom repository.
4. Select category **Dashboard** or **Lovelace/Frontend** depending on your HACS version.
5. Install **Car Heater Card**.
6. Reload the browser cache.

HACS should add the resource automatically. If not, add:

```yaml
url: /hacsfiles/car-heater-card/car-heater-card.js
type: module
```

## Example

```yaml
type: custom:car-heater-card
```

The card normally detects entities from the Car Heater device automatically. If you have more than one Car Heater device, select the device in the visual editor.

### HACS note

This card uses separate translation files. For that reason `hacs.json` does not use `filename`, because HACS only downloads the single JavaScript file when `filename` is set for frontend plugins. The resource URL is still:

```yaml
url: /hacsfiles/car-heater-card/car-heater-card.js
type: module
```
