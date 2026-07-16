export const ordinaryAdmissionQueueLimit = 128
export const trustedAdmissionQueueLimit = 64
export const submittedEmailAdmissionQueueLimit = 64

export const credentialControlConnectionCount = 2
export const credentialCaptureConnectionCount = 1
export const externalHostConnectionCount = 1
export const totalReservedConnectionCount =
  credentialControlConnectionCount +
  credentialCaptureConnectionCount +
  externalHostConnectionCount
