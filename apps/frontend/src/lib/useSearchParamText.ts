import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

/** How long typing pauses before the URL follows; the input, and whatever it filters, follows every keystroke. */
const SEARCH_PARAM_SYNC_MS = 250;

/**
 * Text kept in a URL search parameter (`?key=`) and edited in an input, such as a search box. Returns the text to show
 * and its setter.
 *
 * The input must not be bound to the URL directly: router updates are rendered in a transition, and until one commits
 * React resets a controlled input to the older URL value, so fast typing loses characters. Here the input shows local
 * state, the URL follows with `replace` once typing pauses (no history entry per keystroke), and a change of the
 * parameter made elsewhere (back and forward, a link, another control) replaces the text.
 */
export function useSearchParamText(key: string, delayMs: number = SEARCH_PARAM_SYNC_MS): readonly [string, (text: string) => void] {
  const [params, setParams] = useSearchParams();
  const urlText = params.get(key) ?? "";
  const [text, setText] = useState(urlText);
  // The parameter as of the previous render, and the value it is expected to have (the last one written or adopted):
  // a change to anything else came from elsewhere and replaces the text.
  const [seen, setSeen] = useState(urlText);
  const [expected, setExpected] = useState(urlText);
  if (urlText !== seen) {
    setSeen(urlText);
    if (urlText !== expected) {
      setExpected(urlText);
      setText(urlText);
    }
  }

  // setSearchParams builds on the parameters of the render that created it: the delayed write uses the latest one, so
  // it never reverts a parameter that another control changed in the meantime.
  const latestSetParams = useRef(setParams);
  useEffect(() => {
    latestSetParams.current = setParams;
  }, [setParams]);

  useEffect(() => {
    if (text === urlText) return;
    const timer = window.setTimeout(() => {
      setExpected(text);
      latestSetParams.current(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (text) next.set(key, text);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [text, urlText, key, delayMs]);

  return [text, setText] as const;
}
