/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{vue,ts,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          base: 'var(--surface-base)',
          raised: 'var(--surface-raised)',
          overlay: 'var(--surface-overlay)'
        },
        content: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          fg: 'var(--accent-fg)'
        },
        border: {
          subtle: 'var(--border-subtle)',
          field: 'var(--field-border)'
        },
        field: {
          bg: 'var(--field-bg)',
          border: 'var(--field-border)',
          'border-focus': 'var(--field-border-focus)'
        },
        role: {
          process: 'var(--role-process)',
          function: 'var(--role-function)'
        },
        semantic: {
          warning: 'var(--semantic-warning)',
          error: 'var(--semantic-error)',
          success: 'var(--semantic-success)'
        },
        danger: {
          DEFAULT: 'var(--danger)',
          fg: 'var(--danger-fg)'
        },
        kind: {
          type: 'var(--kind-type)',
          var: 'var(--kind-var)'
        },
        section: {
          functions: 'var(--section-functions)',
          data: 'var(--section-data)',
          constraints: 'var(--section-constraints)'
        },
        gui: {
          canvas: 'var(--gui-canvas)',
          'canvas-soft': 'var(--gui-canvas-soft)',
          ink: 'var(--gui-ink)',
          body: 'var(--gui-body)',
          muted: 'var(--gui-muted)',
          hairline: 'var(--gui-hairline)',
          primary: 'var(--gui-primary)',
          'surface-card': 'var(--gui-surface-card)'
        }
      }
    }
  },
  plugins: []
}
