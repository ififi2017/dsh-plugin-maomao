const privateEntry = 'maomao-dsh-private';
const qqEntry = 'maomao-dsh-qq';
const shareModes = ['off', 'shadow', 'send'];
const isHour = (value) => Number.isInteger(value) && value >= 0 && value <= 23;

export async function manageMemorySettings(ctx, request, signal) {
  const editor = ctx.get('configEditor');
  const find = (id) => editor?.entries().find((entry) => entry.options.id === id);
  const privateConnector = ctx.get('maomaoPrivate');
  if (request?.action === 'list') {
    const ordinary = find(privateEntry)?.options.config;
    const qq = find(qqEntry)?.options.config;
    const share = ordinary?.sharing;
    return {
      privateMemory: { available: !!ordinary, enabled: ordinary?.memory?.enabled !== false,
        shared: ordinary?.memory?.shared !== false },
      qqMemory: { available: !!qq, enabled: qq?.ordinary?.enabled === true, stickerEmbedding: qq?.stickers?.embedding === true },
      sharing: {
        available: !!ordinary,
        mode: share?.enabled === true ? share.schedule?.mode ?? 'manual' : 'off',
        target: privateConnector?.status?.().sharing?.destinationId ?? '',
        targets: privateConnector?.shareTargets?.() ?? [],
        browse: share?.schedule?.browse === true,
        lonely: share?.schedule?.lonely !== false,
        quietStart: share?.quietHours?.start ?? 23,
        quietEnd: share?.quietHours?.end ?? 8,
      },
    };
  }
  const { section, value } = request ?? {};
  if (request?.action !== 'save' || !value || !['privateMemory', 'qqMemory', 'sharing'].includes(section)) return { status: 'invalid' };
  const entry = find(section === 'qqMemory' ? qqEntry : privateEntry);
  if (!entry) return { status: 'unavailable' };
  let edit;
  if (section === 'privateMemory') {
    if (typeof value.enabled !== 'boolean' || typeof value.shared !== 'boolean') return { status: 'invalid' };
    edit = (current) => ({ ...current, memory: { ...current.memory, enabled: value.enabled, shared: value.shared } });
  } else if (section === 'qqMemory') {
    if (typeof value.enabled !== 'boolean' || typeof value.stickerEmbedding !== 'boolean') return { status: 'invalid' };
    edit = (current) => ({ ...current, ordinary: { ...current.ordinary, enabled: value.enabled },
      stickers: { ...current.stickers, embedding: value.stickerEmbedding } });
  } else {
    const { mode, target, browse, lonely, quietStart, quietEnd, sendConfirmed } = value;
    if (!shareModes.includes(mode) || typeof browse !== 'boolean' || typeof lonely !== 'boolean'
      || !isHour(quietStart) || !isHour(quietEnd) || (mode !== 'off' && !browse && !lonely)
      || (mode === 'send' && sendConfirmed !== true)) return { status: 'invalid' };
    const destination = mode !== 'off' && typeof target === 'string' && /^[a-f0-9]{64}$/.test(target)
      ? privateConnector?.shareTarget?.(target) : null;
    if (mode !== 'off' && !destination) return { status: 'destination_missing' };
    edit = (current) => {
      if (destination && (current[destination.platform]?.enabled !== true
        || current[destination.platform].accountId !== destination.accountId)) throw new Error('Share target changed');
      return { ...current, sharing: {
        ...current.sharing, enabled: mode !== 'off', destination: destination ?? current.sharing?.destination ?? null,
        schedule: { ...current.sharing?.schedule, enabled: mode !== 'off', mode: mode === 'off' ? 'shadow' : mode, browse, lonely },
        quietHours: { start: quietStart, end: quietEnd },
      } };
    };
  }
  try {
    signal?.throwIfAborted();
    await editor.edit(entry, edit);
    return { status: 'saved' };
  } catch { return { status: 'save_failed' }; }
}
