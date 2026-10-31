import { ProjectRole } from '@activepieces/core-utils';
import {
  CreateOtpRequestBody,
  GetCurrentProjectMemberRoleQuery,
  CompleteSignUpRequest,
  RequestEmailCodeRequest,
  ResetPasswordRequestBody,
  VerifyEmailRequestBody,
  AuthenticationResponse,
  ClaimTokenRequest,
  FederatedAuthnLoginResponse,
  SignInRequest,
  SignUpRequest,
  SwitchPlatformRequest,
  ThirdPartyAuthnProviderEnum,
  UserIdentity,
  VerifyEmailCodeRequest,
} from '@activepieces/shared';

import { api } from '@/lib/api';

export const authenticationApi = {
  signIn(request: SignInRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/authentication/sign-in',
      request,
    );
  },
  signUp(request: SignUpRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/authentication/sign-up',
      request,
    );
  },
  getFederatedAuthLoginUrl(providerName: ThirdPartyAuthnProviderEnum) {
    return api.get<FederatedAuthnLoginResponse>(`/v1/authn/federated/login`, {
      providerName,
    });
  },
  getCurrentProjectRole(query: GetCurrentProjectMemberRoleQuery) {
    return api.get<ProjectRole | null>('/v1/project-members/role', query);
  },
  claimThirdPartyRequest(request: ClaimTokenRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/authn/federated/claim',
      request,
    );
  },
  requestEmailCode(request: RequestEmailCodeRequest) {
    return api.post<void>('/v1/authentication/otp/request', request);
  },
  completeSignUp(request: CompleteSignUpRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/authentication/complete-sign-up',
      request,
    );
  },
  verifyEmailCode(request: VerifyEmailCodeRequest) {
    return api.post<AuthenticationResponse>(
      '/v1/authentication/otp/verify',
      request,
    );
  },
  sendOtpEmail(request: CreateOtpRequestBody) {
    return request.type === 'PASSWORD_RESET'
      ? api.post<void>('/v1/authentication/request-password-reset', {
          email: request.email,
        })
      : api.post<void>('/v1/otp', request);
  },
  changePassword(request: { currentPassword: string; newPassword: string }) {
    return api.post<void>('/v1/authentication/change-password', request);
  },
  resetPassword(request: ResetPasswordRequestBody) {
    return api.post<void>('/v1/authentication/reset-password', request);
  },
  verifyEmail(request: VerifyEmailRequestBody) {
    return api.post<UserIdentity>('/v1/authn/local/verify-email', request);
  },
  switchPlatform(request: SwitchPlatformRequest) {
    return api.post<AuthenticationResponse>(
      `/v1/authentication/switch-platform`,
      request,
    );
  },
};
