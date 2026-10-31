// State describes an ongoing intention. Actions are finite units of work.
// The updater knows neither community operations nor individual games: it
// requests a pause and waits until the owner reaches a boundary with no action.
export const COMPANION_STATES = {
  watch: { label: '持续观察', resumable: true },
  game: { label: '游戏活动', resumable: true },
  single: { label: '观察一次', resumable: false },
  publish_post: { label: '提交草稿', resumable: false },
  engagement: { label: '执行互动', resumable: false },
};
export const COMPANION_ACTIONS = {
  reply: '阅读并处理一条互动',
  draft: '提交一份草稿',
  draft_proposal: '构思一份草稿',
  diary: '完成一次日记任务',
  submission: '确认一次提交',
  game: '完成当前一局游戏',
  game_step: '处理当前游戏进度',
  reflection: '完成一次游戏复盘',
  activity_decision: '确认下一项活动',
};

export class ActivityLifecycle {
  constructor({ states = COMPANION_STATES, actions = COMPANION_ACTIONS } = {}) {
    this.states = new Map(Object.entries(states)); this.actions = new Map(Object.entries(actions));
    this.active = new Map(); this.state = null; this.requested = false; this.parked = false;
  }
  registerState(name, definition) { this.states.set(name, { ...definition }); }
  registerAction(name, label) { this.actions.set(name, label); }
  resumable(state = this.state) { return this.states.get(state)?.resumable === true; }
  start(state) {
    if (!this.states.has(state) || this.active.size) throw new Error('invalid_activity_state');
    this.cancelPause(); this.state = state;
  }
  begin(action) {
    if (!this.actions.has(action) || this.parked) throw new Error('invalid_activity_action');
    const key = Symbol(action); this.active.set(key, action);
    return () => this.active.delete(key);
  }
  async run(action, work) {
    const end = this.begin(action);
    try { return await work(); } finally { end(); }
  }
  requestPause() { if (this.resumable()) this.requested = true; }
  cancelPause() { this.requested = false; this.release?.(); }
  canPark() { return this.requested && this.resumable() && !this.active.size; }
  async checkpoint(signal, onPark = () => {}) {
    if (!this.canPark()) return false;
    signal.throwIfAborted(); this.parked = true;
    try {
      await new Promise((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', stopped); resolve(); };
        const stopped = () => { signal.removeEventListener('abort', stopped); reject(signal.reason); };
        this.release = finish; signal.addEventListener('abort', stopped, { once: true });
        onPark();
        if (signal.aborted) stopped();
        else if (!this.requested) finish();
      });
      return true;
    } finally { this.parked = false; this.release = null; }
  }
  view() {
    return { state: this.state, label: this.states.get(this.state)?.label || '',
      actions: [...new Set(this.active.values())].map(type => ({ type, label: this.actions.get(type) })),
      update: this.parked ? 'paused' : this.requested ? 'finishing_action' : null };
  }
}
