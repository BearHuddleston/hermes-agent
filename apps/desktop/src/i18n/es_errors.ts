import type { TranslationOverrides } from './define-locale'

// The error boundary's and generic failure copy, composed by es.ts.
export const esErrors = {
  errors: {
    genericFailure: 'Algo salió mal',
    boundaryTitle: 'Algo se rompió en la interfaz',
    boundaryDesc: 'La vista encontró un error inesperado. Tus chats y configuración están a salvo.',
    boundaryDetails: 'Detalles',
    sendDiagnostics: 'Enviar diagnóstico',
    reloadWindow: 'Recargar ventana',
    openLogs: 'Abrir registros'
  }
} satisfies Pick<TranslationOverrides, 'errors'>
