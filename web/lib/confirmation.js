import { signal } from "./h.js";

export const confirmation = signal(null);

export function confirmAction(options, action) {
  if (confirmation.value) return;
  confirmation.value = { ...options, action };
}

export function finishConfirmation(accepted = false) {
  const pending = confirmation.value;
  confirmation.value = null;
  if (accepted) pending?.action();
}
