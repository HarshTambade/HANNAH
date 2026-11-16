/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        ink: "#0f172a",
        slate: {
          50: "#f8fafc",
          900: "#0f172a",
          950: "#020617",
        },
        // Soft pastel palette per Phase 23 spec
        pastel: {
          lavender: "#F3F0FF",
          yellow: "#FFFBE6",
          cyan: "#EBF8FF",
        },
        accent: {
          purple: "#8B5CF6",
          peach: "#FDBA74",
          blue: "#3B82F6",
          mint: "#10B981",
        },
      },
      backgroundImage: {
        "gradient-hero": "linear-gradient(135deg, #F3F0FF 0%, #FFFBE6 100%)",
        "mesh-indigo": "radial-gradient(ellipse at 24% 44%, rgba(86, 67, 190, 0.22), transparent 44%), radial-gradient(ellipse at 78% 18%, rgba(20, 184, 166, 0.06), transparent 34%)",
        "mesh-pastel": "radial-gradient(ellipse at 30% 30%, rgba(139, 92, 246, 0.15), transparent 50%), radial-gradient(ellipse at 70% 70%, rgba(253, 186, 116, 0.12), transparent 50%)",
      },
      borderRadius: {
        card: "2rem",
        pill: "9999px",
      },
      boxShadow: {
        soft: "0 4px 20px -4px rgba(0,0,0,0.04)",
        "soft-xl": "0 20px 40px -8px rgba(0,0,0,0.08)",
        glow: "0 0 40px rgba(139, 92, 246, 0.30)",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "float": "float 6s ease-in-out infinite",
        "fade-in": "fadeIn 0.8s ease-out forwards",
        "slide-up": "slideUp 0.6s ease-out forwards",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-12px)" },
        },
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(30px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
