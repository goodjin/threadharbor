import type { AuthNamespaceInput } from './contracts.ts';
import { MCodeOAuthCore } from './auth-core.ts';
import { createCredentialStore } from './credential-store/factory.ts';
import { createAuthNamespace } from './namespace.ts';
import { migrateLegacyAuthNamespace } from './namespace-migration.ts';
import { HttpOAuthClient, type HttpOAuthClientOptions } from './oauth-client.ts';
import {
  createAuthManager,
  createTokenProvider,
  type MCodeAuthManager,
  type MCodeTokenProvider,
} from './token-provider.ts';

export interface CreateMCodeLocalAuthOptions extends AuthNamespaceInput {
  fetchImpl?: typeof fetch;
  endpoints: Pick<
    HttpOAuthClientOptions,
    | 'deviceAuthorizationEndpoint'
    | 'deviceAuthorizationHeaders'
    | 'tokenEndpoint'
    | 'revocationEndpoint'
  >;
}

export function createMCodeTokenProvider(options: CreateMCodeLocalAuthOptions): MCodeTokenProvider {
  return createTokenProvider(createCore(options));
}

export function createMCodeAuthManager(options: CreateMCodeLocalAuthOptions): MCodeAuthManager {
  return createAuthManager(createCore(options));
}

function createCore(options: CreateMCodeLocalAuthOptions): MCodeOAuthCore {
  const namespace = createAuthNamespace(options);
  return new MCodeOAuthCore({
    namespace,
    credentialStore: createCredentialStore({ authHome: namespace.namespaceHome }),
    oauthClient: new HttpOAuthClient({ ...options.endpoints, fetchImpl: options.fetchImpl }),
    initialize: () => migrateLegacyAuthNamespace(namespace),
  });
}
