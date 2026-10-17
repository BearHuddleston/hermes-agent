import type { TranslationOverrides } from './define-locale'

// Shared chats (Webapp): presence, turn ownership and per-chat sharing, spread into es.ts.
export const esSharedChats = {
  presence: {
    you: 'tú',
    typingOne: name => `${name} está escribiendo`,
    typingTwo: (first, second) => `${first} y ${second} están escribiendo`,
    typingMany: count => `${count} personas están escribiendo`,
    windows: count => `${count} ventanas`,
    renameTitle: 'Tu nombre en este chat',
    renamePlaceholder: 'Nombre que ven los demás',
    renameHint:
      'Aparece junto a tu puntero y en tu avatar. Tu inicio de sesión decide quién eres; esto es solo la etiqueta.',
    renameSave: 'Guardar',
    turnRunning: name => `Turno de ${name} · tus mensajes esperan`,
    waitingFor: name => `Esperando la respuesta de ${name}`,
    chatCreator: 'quien creó el chat',
    viewingHere: name => `${name} está leyendo aquí`
  },
  sharing: {
    share: 'Compartir',
    title: 'Compartir este chat',
    description:
      'Las personas que añadas ven este chat y sus apps en directo. Quien observa solo mira; quien participa también puede enviar mensajes.',
    claimTitle: 'Primero haz tuyo este agente',
    claimBody:
      'Ahora mismo, cualquiera a quien tu Portal deje iniciar sesión ve todos los chats. Reclama el agente y los demás solo verán los chats que compartas con ellos.',
    claim: 'Reclamar este agente',
    claimFailed: 'No se pudo reclamar este agente',
    yourId: 'Tu ID de cuenta',
    yourIdHint: 'Envíaselo a quien tenga un chat para que pueda añadirte.',
    copy: 'Copiar',
    copied: 'Copiado',
    addPerson: 'Añadir a una persona',
    addPlaceholder: 'ID de cuenta, p. ej. nous:usr_1a2b',
    add: 'Añadir',
    signedInRecently: 'Han iniciado sesión en este agente',
    nobodyYet: 'Nadie más ha iniciado sesión todavía. Cuando alguien lo haga, aparecerá aquí.',
    sharedWith: 'Compartido con',
    notShared: 'Solo tú ves este chat.',
    roleViewer: 'Observa',
    roleParticipant: 'Participa',
    roleOwner: 'Propietario',
    remove: 'Quitar',
    changeFailed: 'No se pudo cambiar con quién se comparte este chat',
    viewerComposer: 'Solo lectura. Pide participar.',
    viewerNote: 'Solo lectura',
    accessRemoved: 'Ya no se comparte contigo.'
  }
} satisfies Pick<TranslationOverrides, 'presence' | 'sharing'>
