<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Application structure
- Keep migration views in a shared workspace with dedicated TanStack workflow URLs so navigation stays consistent.
- Keep demonstration records in a root React context across workflow navigation; real document storage and migration processing require a separately connected service.
- Define visual roles in src/styles.css and use the shared Button for workspace controls.
