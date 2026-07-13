import styles from './brand-mark.module.css'

/**
 * The square "IS" instance monogram, shared by the product masthead and the
 * unauthenticated auth layout so the two never drift apart. Decorative: the
 * accessible name is carried by the surrounding wordmark text.
 */
export function BrandMark() {
  return (
    <span className={styles.mark} aria-hidden="true">
      IS
    </span>
  )
}
