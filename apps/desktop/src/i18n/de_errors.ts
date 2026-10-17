import type { TranslationOverrides } from './define-locale'

// The error boundary's and generic failure copy, composed by de.ts.
export const deErrors = {
  errors: {
    genericFailure: 'Etwas ist schiefgelaufen',
    boundaryTitle: 'Etwas ist in der Oberfläche kaputtgegangen',
    boundaryDesc:
      'In dieser Ansicht ist ein unerwarteter Fehler aufgetreten. Ihre Chats und Einstellungen sind sicher.',
    boundaryDetails: 'Details',
    sendDiagnostics: 'Diagnosedaten senden',
    reloadWindow: 'Fenster neu laden',
    openLogs: 'Logs öffnen'
  }
} satisfies Pick<TranslationOverrides, 'errors'>
