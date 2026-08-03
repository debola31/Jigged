import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from 'react';

export interface UseLoadResult<T> {
  /** Loaded value, or `null` until the first load resolves. */
  data: T | null;
  /** True until the first load (or a `reload()`) resolves or rejects. */
  loading: boolean;
  /** The rejection from the most recent load, or `null`. */
  error: unknown;
  /**
   * Re-run the loader (e.g. after a mutation); shows the loading state again.
   * Resolves once the refetch settles, so callers can `await reload()` before
   * acting on the fresh data (errors are captured into `error`, never thrown).
   */
  reload: () => Promise<void>;
}

/**
 * Client-side data loading that does NOT trip `react-hooks/set-state-in-effect`.
 *
 * Every `setState` happens inside the async callback — never synchronously in
 * the effect body. `loading` starts `true` (so the first render shows a
 * spinner without a synchronous `setLoading(true)`), and the mount effect only
 * kicks off the fetch. This is React's blessed shape for client fetch-in-effect
 * ("You Might Not Need an Effect" / "Synchronizing with Effects": extract the
 * fetch + ignore-flag into a custom Hook).
 *
 * Loads on mount and whenever `deps` change. A stale in-flight result is
 * dropped (request-id guard) so an out-of-order response can't clobber newer
 * data. On a `deps` change the previous `data` stays visible until the new load
 * resolves (stale-while-revalidate, no spinner flash); use `reload()` for an
 * explicit post-mutation refetch that re-shows the loading state.
 *
 * `opts.onError` runs inside the rejection callback (not an effect), so callers
 * can surface a snackbar/toast on load failure without re-introducing a
 * set-state-in-effect.
 */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  opts?: { onError?: (error: unknown) => void },
): UseLoadResult<T> {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: unknown;
  }>({ data: null, loading: true, error: null });

  // Only the most-recent run may write state — guards against out-of-order
  // responses (deps changed, or reload() fired, while a fetch was in flight).
  const runId = useRef(0);

  /**
   * PASS PRIMITIVE DEPS (ids, hrefs, counts). An object or array literal rebuilt each
   * render is a new identity each render, which re-memoises `load`, which re-runs the
   * effect, which resolves and setStates a fresh object (no Object.is bailout), which
   * renders again — an infinite loop.
   *
   * It is worth a runtime warning rather than a comment because the failure is silent in
   * every channel you would normally check. The setState happens in a promise callback,
   * not synchronously in render, so React's "Maximum update depth exceeded" guard never
   * fires. If the loader short-circuits (an empty array to map over) there is no network
   * traffic. And every iteration is sub-millisecond, so a longtask observer sees nothing.
   * The only symptom is a pegged CPU core — which is exactly how NoteEditDialog's
   * `media = []` default parameter went unnoticed while it made the operator "Me" tab
   * feel frozen. Same caller-owned-deps contract as `useSetOperatorChrome`, which carries
   * the same warning in prose.
   */
  if (process.env.NODE_ENV !== 'production') {
    for (const dep of deps) {
      if (dep !== null && typeof dep === 'object') {
        console.error(
          'useLoad: received a non-primitive dependency (%o). If it is rebuilt each ' +
            'render this is an infinite render loop. Pass a primitive (id/href), or ' +
            'memoise the value with a stable identity.',
          dep,
        );
        break;
      }
    }
  }

  // Hold the latest onError in a ref so `load` need not depend on a possibly
  // inline callback. Updated AFTER render (the react-hooks/refs rule forbids
  // ref writes in the render body), never during it.
  const onErrorRef = useRef(opts?.onError);
  useEffect(() => {
    onErrorRef.current = opts?.onError;
  });

  const load = useCallback((): Promise<void> => {
    const id = ++runId.current;
    // `loader()` returns a promise; every setState below runs only in the
    // resolved/rejected callback, never synchronously in the effect body — so
    // this keeps set-state-in-effect quiet (loading already starts `true`).
    return loader()
      .then((data) => {
        if (id === runId.current) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (id !== runId.current) return;
        setState((s) => ({ ...s, loading: false, error }));
        onErrorRef.current?.(error);
      });
    // `deps` is the caller-owned dependency list (exactly like useEffect's).
    // The compiler memoization rules want an array literal here, which a
    // generic deps-forwarding hook fundamentally can't provide — so disable
    // them for this single line.
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps);

  useEffect(() => {
    load();
    // Invalidate any in-flight run when deps change or the component unmounts.
    return () => {
      runId.current += 1;
    };
  }, [load]);

  const reload = useCallback((): Promise<void> => {
    setState((s) => ({ ...s, loading: true }));
    return load();
  }, [load]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    reload,
  };
}
