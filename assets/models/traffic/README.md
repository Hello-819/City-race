# Extra traffic cars

Drop `.glb` car models in this folder and list them in `manifest.json` to add
them to the traffic mix (they are used for traffic only, not as player cars):

```json
[
  {
    "file": "sedan.glb",
    "name": "Family sedan",
    "wheels": { "fl": "Wheel_FL", "fr": "Wheel_FR", "rl": "Wheel_RL", "rr": "Wheel_RR" },
    "paint": "Body|Paint",
    "glass": "Glass",
    "tail": "TailLight",
    "head": "HeadLight"
  }
]
```

- `wheels` are the node names of the four wheels (required; used to orient,
  size and spin the model). Front/rear is detected from these, left/right from
  their positions.
- `paint`, `glass`, `tail`, `head` are optional regular expressions matched
  against material names (paint gets random colours, tail lights glow when braking).
- Models are automatically simplified and merged for performance.
