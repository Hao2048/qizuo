import { useSyncExternalStore } from "react";
export type Appearance = "system" | "light" | "dark";
const key = "pih:appearance";
const listeners = new Set<() => void>();
function read(): Appearance {
  try {
    const value = localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
let appearance = read();
function apply() {
  document.documentElement.dataset.theme = appearance;
}
export function setAppearance(value: Appearance) {
  appearance = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Theme still works when storage is unavailable. */
  }
  apply();
  listeners.forEach((listener) => listener());
}
export function useAppearance() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => appearance,
  );
}
apply();
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null) {
    appearance = read();
    apply();
    listeners.forEach((listener) => listener());
  }
});
