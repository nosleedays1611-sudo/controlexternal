const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GAME_VALUES = new Set(['normal', 'max', 'all']);

export class ValidationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export function requireObject(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value;
}

export function id(value, name = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ValidationError(`${name} is invalid`);
  }
  return value;
}

export function text(value, name, { required = true, max = 160, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (value == null) {
    if (!required) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${name} must not be empty`);
  if (Buffer.byteLength(trimmed, 'utf8') > max) {
    throw new ValidationError(`${name} exceeds ${max} bytes`);
  }
  return trimmed;
}

export function boolean(value, name, { required = true } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be boolean`);
  return value;
}

export function integer(value, name, { required = true, min = -1_000_000, max = 1_000_000 } = {}) {
  if (value == null && !required) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function tabCreate(body) {
  requireObject(body);
  return {
    id: id(body.id),
    title: text(body.title, 'title', { max: 160 }),
    icon: text(body.icon, 'icon', { max: 120 }),
    visible: boolean(body.visible ?? true, 'visible'),
    enabled: boolean(body.enabled ?? true, 'enabled'),
    order: integer(body.order ?? 0, 'order')
  };
}

export function tabPatch(body) {
  requireObject(body);
  const out = {};
  const title = text(body.title, 'title', { required: false, max: 160 });
  const icon = text(body.icon, 'icon', { required: false, max: 120 });
  const visible = boolean(body.visible, 'visible', { required: false });
  const enabled = boolean(body.enabled, 'enabled', { required: false });
  const order = integer(body.order, 'order', { required: false });
  if (title !== undefined) out.title = title;
  if (icon !== undefined) out.icon = icon;
  if (visible !== undefined) out.visible = visible;
  if (enabled !== undefined) out.enabled = enabled;
  if (order !== undefined) out.order = order;
  if (Object.keys(out).length === 0) throw new ValidationError('No tab fields supplied');
  return out;
}

export function featureCreate(body) {
  requireObject(body);
  const game = text(body.game ?? 'all', 'game', { max: 16 });
  if (!GAME_VALUES.has(game)) throw new ValidationError('game must be normal, max, or all');
  return {
    id: id(body.id),
    tabID: id(body.tabID, 'tabID'),
    slotID: body.slotID == null ? null : id(body.slotID, 'slotID'),
    title: text(body.title, 'title', { max: 160 }),
    subtitle: text(body.subtitle, 'subtitle', { required: false, max: 500, nullable: true }) ?? null,
    category: text(body.category ?? 'GENERAL', 'category', { max: 120 }),
    game,
    imageName: text(body.imageName, 'imageName', { required: false, max: 160, nullable: true }) ?? null,
    visible: boolean(body.visible ?? true, 'visible'),
    enabled: boolean(body.enabled ?? true, 'enabled'),
    order: integer(body.order ?? 0, 'order'),
    patchID: body.patchID == null ? null : id(body.patchID, 'patchID'),
    withAntennaPatchID: body.withAntennaPatchID == null ? null : id(body.withAntennaPatchID, 'withAntennaPatchID')
  };
}

export function featurePatch(body) {
  requireObject(body);
  const out = {};
  if ('tabID' in body) out.tabID = id(body.tabID, 'tabID');
  if ('slotID' in body) out.slotID = body.slotID == null ? null : id(body.slotID, 'slotID');
  if ('title' in body) out.title = text(body.title, 'title', { max: 160 });
  if ('subtitle' in body) out.subtitle = text(body.subtitle, 'subtitle', { max: 500, nullable: true });
  if ('category' in body) out.category = text(body.category, 'category', { max: 120 });
  if ('game' in body) {
    const game = text(body.game, 'game', { max: 16 });
    if (!GAME_VALUES.has(game)) throw new ValidationError('game must be normal, max, or all');
    out.game = game;
  }
  if ('imageName' in body) out.imageName = text(body.imageName, 'imageName', { max: 160, nullable: true });
  if ('visible' in body) out.visible = boolean(body.visible, 'visible');
  if ('enabled' in body) out.enabled = boolean(body.enabled, 'enabled');
  if ('order' in body) out.order = integer(body.order, 'order');
  if ('patchID' in body) out.patchID = body.patchID == null ? null : id(body.patchID, 'patchID');
  if ('withAntennaPatchID' in body) out.withAntennaPatchID = body.withAntennaPatchID == null ? null : id(body.withAntennaPatchID, 'withAntennaPatchID');
  if (Object.keys(out).length === 0) throw new ValidationError('No feature fields supplied');
  return out;
}

export function patchCreate(body) {
  requireObject(body);
  const patchID = id(body.id);
  const fileName = text(body.fileName ?? `${patchID}.3105`, 'fileName', { max: 255 });
  if (!fileName.toLowerCase().endsWith('.3105')) throw new ValidationError('fileName must end in .3105');
  return {
    id: patchID,
    fileName,
    password: text(body.password ?? '0', 'password', { max: 256 })
  };
}

export function patchMetadata(body) {
  requireObject(body);
  const out = {};
  if ('fileName' in body) {
    const fileName = text(body.fileName, 'fileName', { max: 255 });
    if (!fileName.toLowerCase().endsWith('.3105')) throw new ValidationError('fileName must end in .3105');
    out.fileName = fileName;
  }
  if ('password' in body) out.password = text(body.password, 'password', { max: 256 });
  if (Object.keys(out).length === 0) throw new ValidationError('No patch metadata supplied');
  return out;
}

export function settingsPatch(body) {
  requireObject(body);
  if (!('pollIntervalSeconds' in body)) throw new ValidationError('pollIntervalSeconds is required');
  return { pollIntervalSeconds: integer(body.pollIntervalSeconds, 'pollIntervalSeconds', { min: 15, max: 3600 }) };
}

export function loginBody(body) {
  requireObject(body);
  return {
    username: text(body.username, 'username', { max: 128 }),
    password: text(body.password, 'password', { max: 4096 })
  };
}

export function rollbackBody(body) {
  requireObject(body);
  return { version: integer(body.version, 'version', { min: 1, max: 2_147_483_647 }) };
}
