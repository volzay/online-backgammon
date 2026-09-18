(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.NarduLongNeuralDemo = api;
    api.mount(root.document, root.NarduGame, root.NarduLongNeural);
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const MAX_MODEL_BYTES = 2 * 1024 * 1024;
  const copy = value => JSON.parse(JSON.stringify(value));

  function checkedModel(model, neural) {
    if (!neural || typeof neural.validateModel !== 'function'
      || !model || typeof model !== 'object' || Array.isArray(model)) {
      throw new Error('Нет корректной JSON-модели или валидатора нейросети.');
    }
    if (['long-neural-training-artifact-v1', 'long-neural-training-artifact-v2'].includes(model.schema)) {
      if (!model.trainingManifest || typeof model.trainingManifest !== 'object'
        || Array.isArray(model.trainingManifest)) throw new Error('У учебного артефакта отсутствует манифест.');
      // The manifest is file-supplied metadata, never trusted provenance or executable instructions.
      model = model.model;
      if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('У артефакта отсутствует модель.');
    }
    if (neural.validateModel(model) === false) throw new Error('Формат модели не прошёл проверку.');
    return copy(model);
  }

  async function readModelFile(file, neural) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 2 || file.size > MAX_MODEL_BYTES
      || typeof file.text !== 'function') throw new Error('Нужен JSON-файл размером до 2 МиБ.');
    const text = await file.text();
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_MODEL_BYTES) {
      throw new Error('Модель превышает допустимый размер.');
    }
    let model;
    try { model = JSON.parse(text); } catch { throw new Error('Файл не является корректным JSON.'); }
    return checkedModel(model, neural);
  }

  function createDemoSession(game, neural) {
    if (!game || typeof game.initialState !== 'function' || !neural
      || typeof neural.createNeuralBot !== 'function') throw new Error('Учебный движок недоступен.');
    let state;
    let bot = null;
    let chosen = null;
    let modelValue = null;
    function reset() {
      state = game.initialState('long');
      state.turn = 'white';
      state.phase = 'roll';
      chosen = null;
      return copy(state);
    }
    reset();

    function setModel(model) {
      // A failed replacement cannot leave the previous model enabled.
      bot = null;
      chosen = null;
      modelValue = null;
      const validated = checkedModel(model, neural);
      const candidate = neural.createNeuralBot(game, validated);
      if (!candidate || typeof candidate.plan !== 'function') throw new Error('Модель не создала бота.');
      bot = candidate;
      modelValue = validated;
    }

    function clearModel() { bot = null; chosen = null; modelValue = null; }
    function choose(dieOne, dieTwo) {
      chosen = null;
      if (!bot) throw new Error('Сначала загрузите модель.');
      if (state.winner) throw new Error('Учебная партия завершена.');
      if (![dieOne, dieTwo].every(value => Number.isInteger(value) && value >= 1 && value <= 6)) {
        throw new Error('Учебные кубики должны иметь значения от 1 до 6.');
      }
      // Re-evaluating an unapplied synthetic roll is permitted only in this local laboratory.
      const input = copy(state);
      input.phase = 'roll';
      game.applyRoll(input, dieOne === dieTwo ? [dieOne, dieOne, dieOne, dieOne] : [dieOne, dieTwo]);
      const output = bot.plan(copy(input));
      if (!Array.isArray(output) || output.length > 4) throw new Error('Бот вернул неверный формат хода.');
      const moves = output.map(move => {
        if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.die)
          || move.from < 1 || move.from > 24 || move.die < 1 || move.die > 6) {
          throw new Error('Бот вернул неверный формат хода.');
        }
        return { from: move.from, to: game.moveTo(input.turn, move.from, move.die, input), die: move.die };
      });
      const candidates = game.bestMoveSequences(copy(input), input.turn);
      const key = sequence => JSON.stringify(sequence.map(move => [move.from, move.to, move.die]));
      if (!candidates.some(sequence => key(sequence) === key(moves))) {
        throw new Error('Бот вернул незаконный или неполный ход; позиция не изменена.');
      }
      const preview = copy(input);
      for (const move of moves) {
        if (!game.applyMove(preview, move.from, move.die, { autoEnd: false })) {
          throw new Error('Движок правил отклонил ход; позиция не изменена.');
        }
      }
      // Prediction is a learned score, not a calibrated probability or a certified strength.
      const evaluated = copy(preview);
      if (!evaluated.winner) game.endTurn(evaluated);
      const prediction = typeof neural.predict === 'function'
        ? neural.predict(modelValue, evaluated, input.turn) : null;
      const coverage = typeof bot.getLastDecision === 'function' ? copy(bot.getLastDecision()) : null;
      chosen = { input, preview, moves, prediction };
      return { color: input.turn, dice: input.rolled.slice(), moves: copy(moves), prediction, coverage };
    }

    function apply() {
      if (!bot || !chosen) throw new Error('Нет проверенного выбранного хода.');
      const next = copy(chosen.preview);
      if (!next.winner) game.endTurn(next);
      state = next;
      chosen = null;
      return copy(state);
    }
    return { setModel, clearModel, reset, choose, apply,
      snapshot: () => copy(state), hasModel: () => Boolean(bot), hasPlan: () => Boolean(chosen) };
  }

  function mount(document, game, neural) {
    if (!document) return;
    const get = id => document.getElementById(id);
    const fileInput = get('model-file');
    if (!fileInput) return;
    let session;
    try { session = createDemoSession(game, neural); }
    catch (error) { get('model-status').textContent = error.message; return; }
    let uploadVersion = 0;
    let busy = false;
    function buttons() {
      get('choose').disabled = busy || !session.hasModel() || Boolean(session.snapshot().winner);
      get('apply').disabled = busy || !session.hasPlan();
      get('reset').disabled = busy;
    }
    function render() {
      const state = session.snapshot();
      const board = get('board');
      board.replaceChildren();
      const points = [...Array.from({ length: 12 }, (_, index) => 24 - index),
        ...Array.from({ length: 12 }, (_, index) => index + 1)];
      for (const point of points) {
        const stack = state.points[point];
        const item = document.createElement('div');
        item.className = `point${stack ? '' : ' empty'}`;
        item.setAttribute('aria-label', `Пункт ${point}: ${stack ? `${stack.color === 'white' ? 'белых' : 'тёмных'} ${stack.count}` : 'пусто'}`);
        const number = document.createElement('span');
        number.textContent = String(point);
        const checkers = document.createElement('span');
        checkers.className = `checkers ${stack?.color || 'white'}`;
        checkers.textContent = stack ? String(stack.count) : '0';
        item.append(number, checkers);
        board.append(item);
      }
      get('board-summary').textContent = `Снято: белые ${state.off.white}, тёмные ${state.off.dark}.`;
      get('turn-status').textContent = state.winner
        ? `Учебная партия завершена: ${state.winner === 'white' ? 'белые' : 'тёмные'} выиграли.`
        : `Учебный ход: ${state.turn === 'white' ? 'белые' : 'тёмные'}. Кубики задаются вручную, не генерируются порталом.`;
      buttons();
    }
    fileInput.addEventListener('change', async () => {
      const version = ++uploadVersion;
      session.clearModel();
      busy = true;
      buttons();
      get('model-status').textContent = 'Проверяем JSON и размер весов…';
      get('plan-output').textContent = 'Выбор хода отключён до проверки новой модели.';
      try {
        const model = await readModelFile(fileInput.files?.[0], neural);
        if (version !== uploadVersion) return;
        session.setModel(model);
        get('model-status').textContent = model.trainingSteps === 0
          ? 'Формат модели проверен. Сеть НЕОБУЧЕНА: случайная инициализация. Сила игры не сертифицирована.'
          : 'Формат модели проверен. Сила игры не сертифицирована.';
      } catch (error) {
        if (version !== uploadVersion) return;
        session.clearModel();
        get('model-status').textContent = `Модель отклонена: ${error.message}`;
      } finally {
        if (version === uploadVersion) { busy = false; buttons(); }
      }
    });
    get('turn-form').addEventListener('submit', event => {
      event.preventDefault();
      if (busy) return;
      try {
        const result = session.choose(Number(get('die-one').value), Number(get('die-two').value));
        get('plan-output').textContent = JSON.stringify({
          учебный_бросок: result.dice,
          выбранные_законные_ходы: result.moves,
          оценка_сети_не_доказанная_вероятность: result.prediction,
          покрытие_поиска: result.coverage,
        }, null, 2);
      } catch (error) { get('plan-output').textContent = error.message; }
      buttons();
    });
    get('apply').addEventListener('click', () => {
      if (busy) return;
      try { session.apply(); render(); }
      catch (error) { get('plan-output').textContent = error.message; buttons(); }
    });
    get('reset').addEventListener('click', () => {
      if (busy) return;
      session.reset();
      get('plan-output').textContent = 'Новая учебная партия. Задайте кубики и выберите ход.';
      render();
    });
    render();
  }

  return { MAX_MODEL_BYTES, readModelFile, createDemoSession, mount };
});
