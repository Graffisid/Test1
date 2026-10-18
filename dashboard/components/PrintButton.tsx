"use client";

import { Icon } from "./Icon";

export function PrintButton() {
  return (
    <button type="button" className="btn" onClick={() => window.print()}>
      <Icon name="printer" /> Print or save as PDF
    </button>
  );
}
