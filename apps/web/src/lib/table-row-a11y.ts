import type { KeyboardEvent } from "react";

/** Enter / Space — for expandable `role="button"` rows */
export function tableRowToggleKeyDown(
  e: KeyboardEvent<HTMLTableRowElement>,
  toggle: () => void,
) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle();
  }
}

/** Enter — for `role="link"` row navigation */
export function tableRowLinkKeyDown(
  e: KeyboardEvent<HTMLTableRowElement>,
  navigate: () => void,
) {
  if (e.key === "Enter") {
    e.preventDefault();
    navigate();
  }
}
