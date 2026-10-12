export const SHARED_OWNER = 'local-owner:shared';

// All authenticated clients belong to the same single-user permission domain
// only when explicitly enabled. OAuth token validation/revocation stays intact.
export function createOwnerPolicy({ sharedOwner } = {}) {
  if (sharedOwner !== undefined && typeof sharedOwner !== 'boolean') throw new TypeError('sharedOwner must be a boolean');
  const ownerForClient = clientId => {
    if (typeof clientId !== 'string' || !clientId.length) throw new TypeError('Authenticated OAuth client is required');
    return sharedOwner ? SHARED_OWNER : `local-owner:${clientId}`;
  };
  return {
    ownerForClient,
    revokeClient(clientId, revokeOwner) {
      const owner = ownerForClient(clientId);
      // A client disconnect must not revoke the other clients' shared resources.
      if (!sharedOwner) return revokeOwner(owner);
    },
  };
}
