// examples/document-set.mdy — a document SET in one file: the entry composes
// its member documents entirely by query.
export const defaultInput = `title: Team Roster
+++
= {{ res.data.title }}

% for (const m of $.find({ role: 'member' })) {
{{ $.render({ template: 'member-card' }, m) }}
% }
---
template: member-card
+++
=== {{ req.name }}

- Age: {{ req.age }}
- Skills: {{ req.skills.join(', ') }}
---
role: member
name: Alice
age: 30
skills: [js, python]
+++
---
role: member
name: Bob
age: 41
skills: [go, rust]
+++
`;
