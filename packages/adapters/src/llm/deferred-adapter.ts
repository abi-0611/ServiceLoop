import type {
  LlmCompletion,
  LlmExtraction,
  LlmExtractionRequest,
  LlmPort,
  LlmRequest,
  LlmTaskClass,
} from './port';
import { SandboxLlmAdapter } from './sandbox-adapter';

/**
 * A model chosen after the world that uses it exists.
 *
 * There is one ordering problem that keeps recurring in the phase-5 fixtures: a
 * scripted agent turn has to name an id — an approval, a job card — that does
 * not exist until the world has been built, and the world needs an `LlmPort` to
 * be built at all. The alternatives are both bad. Inventing an id and hoping a
 * row matches it produces a test that passes while the tool call silently
 * refuses; rebuilding the world after the script means two worlds.
 *
 * So the slot is filled once both exist. Until it is, calls fall through to a
 * plain sandbox adapter rather than throwing, because some of the traffic — the
 * claim judge, an explanation writer — arrives before the script is installed
 * and is nothing to do with it.
 */
export class DeferredLlmAdapter implements LlmPort {
  readonly driver: 'anthropic' | 'sandbox' | 'mock' = 'mock';

  private inner: LlmPort;

  constructor(fallback: LlmPort = new SandboxLlmAdapter()) {
    this.inner = fallback;
  }

  /** Installs the model this world should use from here on. */
  use(port: LlmPort): void {
    this.inner = port;
  }

  modelFor(taskClass: LlmTaskClass): string {
    return this.inner.modelFor(taskClass);
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return this.inner.complete(request);
  }

  async extract<T>(request: LlmExtractionRequest<T>): Promise<LlmExtraction<T>> {
    return this.inner.extract(request);
  }
}
