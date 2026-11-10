/**
 * The divisions the league runs.
 *
 * Every one of these used to be a ternary — `cls === 'gt4' ? x : y` —
 * spread across eight files, which worked exactly as long as there were
 * two divisions and silently mislabelled everything the moment there were
 * three. A third division should be one line here, not a search.
 *
 * Order matters: it is the order they appear in, and the first is the
 * default for anything that does not say which division it means.
 */
export const CLASSES = ['gt3', 'gt4', 'truck'];

export const CLASS_LABEL = { gt3: 'GT3', gt4: 'GT4', truck: 'TRUCK' };

/** Embed colours. Truck is white, which reads as a bright bar on Discord's dark theme. */
export const CLASS_COLOUR = { gt3: 0xE10600, gt4: 0x0033A0, truck: 0xFFFFFF };

/** Anything at all in, a real division out. Unknown falls back to the first. */
export const normClass = c => {
  const k = String(c == null ? '' : c).trim().toLowerCase();
  return CLASSES.includes(k) ? k : CLASSES[0];
};

export const classLabel  = c => CLASS_LABEL[normClass(c)];
export const classColour = c => CLASS_COLOUR[normClass(c)];

/** The choices a slash-command option offers. */
export const CLASS_CHOICES = CLASSES.map(k => ({ name: CLASS_LABEL[k], value: k }));

/** Where a division's results are announced, if a channel is configured. */
export const announceChannel = (env, cls) =>
  env[`ANNOUNCE_CHANNEL_${CLASS_LABEL[normClass(cls)]}`] || '';
