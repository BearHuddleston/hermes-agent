import type { TranslationOverrides } from './define-locale'

// The error boundary's and generic failure copy, composed by fr.ts.
export const frErrors = {
  errors: {
    genericFailure: "Une erreur s'est produite",
    boundaryTitle: "Un problème est survenu dans l'interface",
    boundaryDesc: 'La vue a rencontré une erreur inattendue. Vos conversations et vos paramètres sont en sécurité.',
    boundaryDetails: 'Détails',
    sendDiagnostics: 'Envoyer les diagnostics',
    reloadWindow: 'Recharger la fenêtre',
    openLogs: 'Ouvrir les journaux'
  }
} satisfies Pick<TranslationOverrides, 'errors'>
