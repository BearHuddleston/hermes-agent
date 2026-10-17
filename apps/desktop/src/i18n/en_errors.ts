import type { Translations } from './types'

// The error boundary's and generic failure copy, composed by en.ts.
export const enErrors = {
  errors: {
    genericFailure: 'Something went wrong',
    boundaryTitle: 'Something broke in the interface',
    boundaryDesc: 'The view hit an unexpected error. Your chats and settings are safe.',
    boundaryDetails: 'Details',
    sendDiagnostics: 'Send diagnostics',
    reloadWindow: 'Reload window',
    openLogs: 'Open logs'
  }
} satisfies Pick<Translations, 'errors'>
