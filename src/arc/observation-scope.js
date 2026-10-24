import { setMaxListeners } from 'node:events';

function timeoutError(code) {
  return Object.assign(new Error(code), { code });
}

// Use a pool with a server-side statement_timeout as well as this client deadline.
// Destroy cancelled connections (including late acquisitions) instead of recycling
// a client with an unfinished query or indexer transaction.
function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', abort));
  });
}

export function createObservationScope(pool, { timeoutMs = 30_000, queryTimeoutMs = 5_000,
  signal: parentSignal = null } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  setMaxListeners(64, signal); // One sample fans out to wallet RPCs and summary reads.
  const active = new Set();
  const abort = (reason = timeoutError('ARC_OBSERVER_STOPPED')) => controller.abort(reason);
  const parentAbort = () => abort(parentSignal.reason);
  if (parentSignal?.aborted) parentAbort();
  else parentSignal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => abort(timeoutError('ARC_OBSERVER_SAMPLE_TIMEOUT')), timeoutMs);
  const destroy = () => { for (const release of [...active]) release(true); };
  signal.addEventListener('abort', destroy, { once: true });

  async function connect() {
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() => pool.connect());
    let client;
    try { client = await abortable(pending, signal); }
    catch (error) {
      pending.then((lateClient) => lateClient.release(true)).catch(() => {});
      throw error;
    }
    let released = false;
    const onConnectionError = (error) => abort(error);
    const release = (failed = false) => {
      if (released) return;
      released = true;
      active.delete(release);
      client.release(Boolean(failed) || signal.aborted);
      client.removeListener?.('error', onConnectionError);
    };
    active.add(release);
    client.on?.('error', onConnectionError);
    if (signal.aborted) { release(true); signal.throwIfAborted(); }
    return {
      async query(text, values) {
        signal.throwIfAborted();
        const queryTimer = setTimeout(() => abort(timeoutError('ARC_OBSERVER_QUERY_TIMEOUT')), queryTimeoutMs);
        try { return await abortable(Promise.resolve().then(() => client.query(text, values)), signal); }
        catch (error) {
          if (error.code === '57014') abort(timeoutError('ARC_OBSERVER_QUERY_TIMEOUT'));
          throw signal.aborted ? signal.reason : error;
        }
        finally { clearTimeout(queryTimer); }
      },
      release
    };
  }
  const scopedPool = {
    connect,
    async query(text, values) {
      const client = await connect();
      try { return await client.query(text, values); }
      catch (error) { client.release(true); throw error; }
      finally { client.release(); }
    }
  };
  const thisScope = {
    signal, pool: scopedPool, abort,
    run(operation) {
      signal.throwIfAborted();
      return abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }), signal);
    },
    rpc(client) {
      const scoped = client.withSignal?.(signal) || client;
      return new Proxy(scoped, { get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function'
          ? (...args) => thisScope.run(() => value.apply(target, args)) : value;
      } });
    },
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', parentAbort);
      signal.removeEventListener('abort', destroy);
      destroy();
    }
  };
  return thisScope;
}
