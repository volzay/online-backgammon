let enginePromise = null;

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'WildBG analysis failed.';
}

function ensureEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const version = new URL(import.meta.url).searchParams.get('v') || '';
      const glueUrl = new URL('./vendor/wildbg/wildbg_wasm_browser.js', import.meta.url);
      const wasmUrl = new URL('./vendor/wildbg/wildbg_wasm_bg.wasm', import.meta.url);
      if (version) {
        glueUrl.searchParams.set('v', version);
        wasmUrl.searchParams.set('v', version);
      }
      const module = await import(glueUrl.href);
      await module.default({ module_or_path: wasmUrl });
      return new module.Wildbg();
    })().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

function normalizedAnalysisRequest(payload) {
  const values = payload?.board || payload?.pips || payload?.position;
  const pips = values instanceof Int8Array ? values : Int8Array.from(values || []);
  if (pips.length !== 26) throw new Error('WildBG requires a 26-point position.');

  const dice = Array.isArray(payload?.dice) || ArrayBuffer.isView(payload?.dice)
    ? Array.from(payload.dice)
    : [];
  const dieOne = Number(payload?.die1 ?? payload?.dieOne ?? payload?.die_one ?? dice[0]);
  const dieTwo = Number(payload?.die2 ?? payload?.dieTwo ?? payload?.die_two ?? dice[1] ?? dice[0]);
  if (![dieOne, dieTwo].every(die => Number.isInteger(die) && die >= 1 && die <= 6)) {
    throw new Error('WildBG requires two dice between 1 and 6.');
  }
  return {
    pips,
    dieOne,
    dieTwo,
    onePointer: Boolean(
      payload?.isOnePointer ?? payload?.onePointer ?? payload?.one_pointer ?? true,
    ),
  };
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event?.data || {};
  if (!Number.isInteger(id)) return;
  try {
    const engine = await ensureEngine();
    let result;
    if (type === 'preload') {
      result = { ready: true };
    } else if (type === 'analyze') {
      const request = normalizedAnalysisRequest(payload);
      result = engine.analyze(
        request.pips,
        request.dieOne,
        request.dieTwo,
        request.onePointer,
      );
    } else {
      throw new Error(`Unsupported WildBG worker request: ${String(type || '')}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: errorMessage(error) });
  }
});
