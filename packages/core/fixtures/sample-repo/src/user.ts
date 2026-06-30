export interface User {
  id: string;
  name: string;
}

export function greet(user: User): string {
  return `hello ${user.name}`;
}
