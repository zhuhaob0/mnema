/**
 * 写队列：把并发的写请求合并成小批次、串行执行
 *
 * 目的：SQLite 单写者，突发写入（群聊刷屏、批量回填）时并发 BEGIN/INSERT 会互相抢锁。
 * 这里用一个 20ms 的窗口把请求攒起来，同一批放进一个事务里执行，
 * 既降低事务频率，又保证不会有两个写同时进行。
 */

export function createWriteQueue({ db, windowMs = 20, maxBatch = 200, logger = null } = {}) {
  const pending = [];
  let timer = null;
  let running = false;

  function schedule() {
    if (timer || running) return;
    timer = setTimeout(flush, windowMs);
    timer.unref?.();
  }

  async function flush() {
    timer = null;
    if (running) return;
    running = true;
    const batch = pending.splice(0, maxBatch);
    let inTx = false;
    try {
      db.exec('BEGIN');
      inTx = true;
    } catch (error) {
      logger?.warn?.('写队列：开启事务失败，退化为逐条执行', { reason: error?.message ?? String(error) });
    }
    for (const item of batch) {
      try {
        item.resolve(await item.job());
      } catch (error) {
        item.reject(error);
      }
    }
    if (inTx) {
      try {
        db.exec('COMMIT');
      } catch (error) {
        logger?.warn?.('写队列：提交失败', { reason: error?.message ?? String(error) });
      }
    }
    running = false;
    if (pending.length > 0) schedule();
  }

  return {
    /** 排队执行一个写操作；返回它自己的结果 */
    run(job) {
      return new Promise((resolve, reject) => {
        pending.push({ job, resolve, reject });
        schedule();
      });
    },
    get size() {
      return pending.length;
    },
    async drain() {
      while (running || pending.length > 0) {
        await new Promise((r) => { const t = setTimeout(r, 5); t.unref?.(); });
      }
    },
  };
}
