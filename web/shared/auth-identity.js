/* Login aliases are public identifiers, never passwords or authorization rules.
 * Authentication and meet permissions are still enforced by Supabase. */
(function (root) {
  'use strict';
  root.ChungnamAuthIdentity = {
    resolve: function (input, aliases) {
      var id = String(input || '').trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return id;
      if (!/^[a-z0-9_-]{3,32}$/.test(id)) return null;
      if (!aliases || !Object.prototype.hasOwnProperty.call(aliases, id)) return null;
      var email = aliases[id];
      return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
