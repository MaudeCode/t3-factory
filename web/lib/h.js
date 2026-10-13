// Single import point for the rendering runtime, so views never touch vendor paths.
import { h, render, Fragment } from "../vendor/preact.js";
import htm from "../vendor/htm.js";

export { h, render, Fragment };
export { useEffect, useLayoutEffect, useRef, useState, useMemo } from "../vendor/preact-hooks.js";
export { signal, computed, effect, batch, useSignal, useComputed } from "../vendor/preact-signals.js";
export const html = htm.bind(h);
