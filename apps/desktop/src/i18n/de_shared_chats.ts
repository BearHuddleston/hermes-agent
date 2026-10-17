import type { TranslationOverrides } from './define-locale'

// Shared chats (Webapp): presence, turn ownership and per-chat sharing, spread into de.ts.
export const deSharedChats = {
  presence: {
    you: 'du',
    typingOne: name => `${name} schreibt`,
    typingTwo: (first, second) => `${first} und ${second} schreiben`,
    typingMany: count => `${count} Personen schreiben`,
    windows: count => `${count} Fenster`,
    renameTitle: 'Dein Name in diesem Chat',
    renamePlaceholder: 'Name, den andere sehen',
    renameHint:
      'Erscheint neben deinem Zeiger und an deinem Avatar. Wer du bist, bestimmt deine Anmeldung; dies ist nur die Beschriftung.',
    renameSave: 'Speichern',
    turnRunning: name => `${name} ist dran · deine Nachrichten warten`,
    waitingFor: name => `Warte auf die Antwort von ${name}`,
    chatCreator: 'die Person, die den Chat erstellt hat',
    viewingHere: name => `${name} liest hier`
  },
  sharing: {
    share: 'Teilen',
    title: 'Diesen Chat teilen',
    description:
      'Hinzugefügte Personen sehen diesen Chat und seine Apps live. Lesende schauen zu; Teilnehmende können auch Nachrichten senden.',
    claimTitle: 'Mach diesen Agenten zuerst zu deinem',
    claimBody:
      'Wen dein Portal anmelden lässt, sieht derzeit jeden Chat hier. Beanspruche den Agenten, dann sehen alle anderen nur die Chats, die du mit ihnen teilst.',
    claim: 'Agenten beanspruchen',
    claimFailed: 'Agent konnte nicht beansprucht werden',
    yourId: 'Deine Konto-ID',
    yourIdHint: 'Schick sie der Person, der ein Chat gehört, damit sie dich hinzufügen kann.',
    copy: 'Kopieren',
    copied: 'Kopiert',
    addPerson: 'Person hinzufügen',
    addPlaceholder: 'Konto-ID, z. B. nous:usr_1a2b',
    add: 'Hinzufügen',
    signedInRecently: 'Bei diesem Agenten angemeldet',
    nobodyYet: 'Noch hat sich niemand sonst angemeldet. Sobald jemand das tut, erscheint die Person hier.',
    sharedWith: 'Geteilt mit',
    notShared: 'Nur du siehst diesen Chat.',
    roleViewer: 'Lesend',
    roleParticipant: 'Teilnehmend',
    roleOwner: 'Besitzer',
    remove: 'Entfernen',
    changeFailed: 'Freigabe dieses Chats konnte nicht geändert werden',
    viewerComposer: 'Nur Ansicht. Frag nach Teilnahme.',
    viewerNote: 'Nur ansehen',
    accessRemoved: 'Nicht mehr mit dir geteilt.'
  }
} satisfies Pick<TranslationOverrides, 'presence' | 'sharing'>
