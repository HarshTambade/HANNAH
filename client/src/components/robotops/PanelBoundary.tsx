/**
 * Keeps one robot-operations panel's failure inside that panel: an unexpected
 * answer from the server shows a short notice there instead of taking down
 * the whole screen.
 */
import { Component, type ReactNode } from "react";

type Props = { name: string; children: ReactNode };
type State = { failed: string | null };

export class PanelBoundary extends Component<Props, State> {
  state: State = { failed: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">{this.props.name} couldn't be shown.</p>
        <p className="mt-1">The server's answer wasn't what this panel expected ({this.state.failed}). The rest of the screen still works.</p>
        <button type="button" className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100" onClick={() => this.setState({ failed: null })}>Try again</button>
      </section>
    );
  }
}
