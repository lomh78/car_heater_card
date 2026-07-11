<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dark_logo.png">
  <img alt="Car Heater Logo" src="docs/images/logo.png" width="250">
</picture>

# 🚗 Car Heater Card

A modern Lovelace dashboard card for the Car Heater integration.

The card focuses on simplicity while providing detailed information about heating schedules, runtime history and power consumption.

---

## Features

- 🚗 Modern dashboard layout
- 📅 Timeline
- 🌡 Temperature history
- ⚡ Power history
- 📈 Heating Curve
- 🟡 Planned runtime
- 🟨 Running runtime
- 🟧 Historical runtime
- 🟢 Current time indicator
- 🔵 Departure indicator
- 🖱 Custom One-Time Departure slider
- 🌍 English and Swedish translations
- 🌙 Dark mode support
- ☀️ Light mode support
- 🧩 Visual editor
- ❤️ HACS compatible

---

## Installation

Install through HACS.

After installation refresh your browser cache.

Add the card manually:

```yaml
type: custom:car-heater-card
entity: sensor.car_heater_status
```

---

## Configuration

The visual editor supports configuration of:

- Timeline length
- Timeline mode
- Show power graph
- Show temperature graph
- Show heating curve
- Show history

---

## Companion Integration

This card is designed for the Car Heater integration.

---

## License

MIT License
