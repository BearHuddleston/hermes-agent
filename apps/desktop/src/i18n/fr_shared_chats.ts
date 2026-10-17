import type { TranslationOverrides } from './define-locale'

// Shared chats (Webapp): presence, turn ownership and per-chat sharing, spread into fr.ts.
export const frSharedChats = {
  presence: {
    you: 'vous',
    typingOne: name => `${name} écrit`,
    typingTwo: (first, second) => `${first} et ${second} écrivent`,
    typingMany: count => `${count} personnes écrivent`,
    windows: count => `${count} fenêtres`,
    renameTitle: 'Votre nom dans cette discussion',
    renamePlaceholder: 'Nom visible par les autres',
    renameHint:
      'Affiché à côté de votre pointeur et sur votre avatar. Votre connexion détermine qui vous êtes ; ceci n’est qu’une étiquette.',
    renameSave: 'Enregistrer',
    turnRunning: name => `Tour de ${name} · vos messages attendent`,
    waitingFor: name => `En attente de la réponse de ${name}`,
    chatCreator: 'la personne qui a créé la discussion',
    viewingHere: name => `${name} lit ici`
  },
  sharing: {
    share: 'Partager',
    title: 'Partager cette discussion',
    description:
      'Les personnes ajoutées voient cette discussion et ses apps en direct. Les lecteurs suivent ; les participants peuvent aussi envoyer des messages.',
    claimTitle: 'Faites d’abord de cet agent le vôtre',
    claimBody:
      'Toute personne que votre Portal laisse se connecter voit actuellement chaque discussion. Revendiquez l’agent : les autres ne verront plus que les discussions que vous partagez avec eux.',
    claim: 'Revendiquer cet agent',
    claimFailed: 'Impossible de revendiquer cet agent',
    yourId: 'Votre identifiant de compte',
    yourIdHint: 'Envoyez-le à la personne propriétaire d’une discussion pour qu’elle vous ajoute.',
    copy: 'Copier',
    copied: 'Copié',
    addPerson: 'Ajouter une personne',
    addPlaceholder: 'Identifiant de compte, p. ex. nous:usr_1a2b',
    add: 'Ajouter',
    signedInRecently: 'Connectés à cet agent',
    nobodyYet: 'Personne d’autre ne s’est encore connecté. Dès que quelqu’un le fera, il apparaîtra ici.',
    sharedWith: 'Partagée avec',
    notShared: 'Vous seul voyez cette discussion.',
    roleViewer: 'Lecteur',
    roleParticipant: 'Participant',
    roleOwner: 'Propriétaire',
    remove: 'Retirer',
    changeFailed: 'Impossible de modifier le partage de cette discussion',
    viewerComposer: 'Lecture seule. Demandez l’accès.',
    viewerNote: 'Lecture seule',
    accessRemoved: 'N’est plus partagée avec vous.'
  }
} satisfies Pick<TranslationOverrides, 'presence' | 'sharing'>
