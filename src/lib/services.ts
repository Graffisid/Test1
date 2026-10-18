/** Services offered on the capture form, with a typical job value used for the big-deal rule. */
export const SERVICES = {
  furnace_tuneup: { label: "Furnace tune-up", typicalValueCad: 190 },
  emergency_plumbing: { label: "Emergency plumbing", typicalValueCad: 400 },
  drain_cleaning: { label: "Drain cleaning", typicalValueCad: 270 },
  water_heater: { label: "Water heater replacement", typicalValueCad: 2600 },
  furnace_replacement: { label: "New furnace", typicalValueCad: 7000 },
  heat_pump: { label: "Heat pump install", typicalValueCad: 8700 },
} as const;
export type ServiceKey = keyof typeof SERVICES;
export const isService = (s: string): s is ServiceKey => Object.hasOwn(SERVICES, s);
