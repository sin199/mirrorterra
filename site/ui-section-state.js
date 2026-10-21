export const UI_SECTION_STATE = Object.freeze({
  LOADING: 'loading',
  EMPTY: 'empty',
  READY: 'ready',
  STALE: 'stale',
  ERROR: 'error'
});

export function resolveCollectionState({ loading = false, error = null, items = [] } = {}) {
  if (loading) return UI_SECTION_STATE.LOADING;
  if (error) return UI_SECTION_STATE.ERROR;
  return Array.isArray(items) && items.length > 0 ? UI_SECTION_STATE.READY : UI_SECTION_STATE.EMPTY;
}

export function collectionPresentation({ state, emptyMode = 'message', loadingText = 'Loading…',
  emptyText = 'Not yet emerged.', errorText = 'Temporarily unavailable.' } = {}) {
  if (state === UI_SECTION_STATE.LOADING) return { hidden: false, text: loadingText };
  if (state === UI_SECTION_STATE.ERROR) return { hidden: false, text: errorText };
  if (state === UI_SECTION_STATE.EMPTY) {
    return { hidden: emptyMode === 'hidden', text: emptyMode === 'hidden' ? null : emptyText };
  }
  return { hidden: false, text: null };
}
