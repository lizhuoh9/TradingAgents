function createAnalysisControl() {
  let active = null;
  return {
    attach(child) {
      if (active) throw new Error('已有分析任务正在运行');
      const task = { child, stopRequested: false, exited: false, closeSignal: null };
      active = task;
      child.once('exit', () => { task.exited = true; });
      child.on('error', () => {
        if (child.pid == null) { task.exited = true; if (active === task) active = null; }
        else if (!task.exited) task.stopRequested = false;
      });
      child.once('close', (_code, signal) => { task.closeSignal = signal; if (active === task) active = null; });
      return task;
    },
    stop() {
      const task = active;
      if (!task || task.exited || task.child.exitCode !== null || task.child.signalCode !== null) return { requested: false };
      if (task.stopRequested) return { requested: true };
      if (!task.child.kill()) {
        if (task.exited || task.child.exitCode !== null || task.child.signalCode !== null) return { requested: false };
        throw new Error('无法停止分析，请检查运行日志');
      }
      task.stopRequested = true;
      return { requested: true };
    },
  };
}
module.exports = { createAnalysisControl };
