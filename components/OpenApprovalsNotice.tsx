'use client';

/**
 * The marker shown while OPEN_APPROVALS is set.
 *
 * It has to be visible — a weakened control nobody can see is worse than no
 * control, and the usual way this ends badly is somebody forgetting it is on
 * and reporting that approvals "work fine". But a two-line banner on top of
 * every screen is read once and resented thereafter, which is its own kind of
 * invisible.
 *
 * So: one line, dismissible, and it comes back. Dismissal is kept in
 * sessionStorage rather than localStorage on purpose — closing the tab clears
 * it, so the reminder returns every time you come back to the app. You can
 * silence it for now; you cannot silence it for good without removing the flag,
 * which is the point.
 */
import { useEffect, useState } from 'react';

const KEY = 'open-approvals-notice-dismissed';

export function OpenApprovalsNotice() {
  // Rendered hidden on the server and on the first client pass, then shown once
  // sessionStorage has been read — otherwise the markup would differ between
  // the two and React would report a hydration mismatch.
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(sessionStorage.getItem(KEY) !== '1');
    } catch {
      setShow(true); // private mode — better shown than swallowed
    }
  }, []);

  if (!show) return null;

  return (
    <div className="dev-notice" role="status">
      <span className="dev-notice-dot" aria-hidden="true" />
      <span>
        <b>Approvals are open.</b> Any role at a site may take any decision there. Approving your own work is still
        refused. Development only — unset <code>OPEN_APPROVALS</code> to put it back.
      </span>
      <button
        type="button"
        className="dev-notice-close"
        aria-label="Hide this until the next time you open the app"
        title="Hides until you next open the app"
        onClick={() => {
          setShow(false);
          try {
            sessionStorage.setItem(KEY, '1');
          } catch {
            /* private mode — it simply reappears on the next render */
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
