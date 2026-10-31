import { acquisitionUtils } from './acquisition-utils';

function resetIdentity(): void {
  acquisitionUtils.clearAcquisitionParams();
}

export const telemetryUtils = {
  resetIdentity,
  // MVP first-party logs do not create browser analytics session identifiers.
  getSessionId: (): string | null => null,
};
