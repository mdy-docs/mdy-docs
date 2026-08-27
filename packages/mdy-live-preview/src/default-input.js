// examples/document-set.mdy — a document SET in one file: the entry composes
// its member documents entirely by query, and sends each of them a message.
export const defaultInput = `title: Team Roster
+++
= {{ res.data.title }}

% for (const m of $.find({ role: 'member' })) {
{{ $.render({ template: 'member-card' }, m) }}
%   $.publish('welcome', { name: m.name, skills: m.skills })
% }
---
template: member-card
+++
=== {{ req.name }}

- Age: {{ req.age }}
- Skills: {{ req.skills.join(', ') }}
---
messageName: welcome
+++
Welcome aboard, {{ req.name }}. You are message #{{ req.msg.index }},
and we hear you know {{ req.skills.join(' and ') }}.
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
