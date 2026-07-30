type Listener = () => void;
const received: Listener[] = [];
export function addNotificationReceivedListener(fn: Listener) {
  received.push(fn);
  return { remove: () => { const i = received.indexOf(fn); if (i >= 0) received.splice(i, 1); } };
}
export function addNotificationResponseReceivedListener(fn: Listener) {
  return { remove: () => { void fn; } };
}
export function setNotificationHandler(): void {}
export async function getPermissionsAsync() { return { status: 'undetermined' }; }
export async function requestPermissionsAsync() { return { status: 'undetermined' }; }
