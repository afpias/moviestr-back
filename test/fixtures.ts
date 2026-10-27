import type { PreparedMovie } from '../src/common/model'
export const movie: PreparedMovie = {
	id: 'tmdb-603',
	aliases: ['Матрица', 'The Matrix'],
	result: {
		title: 'Матрица',
		originalTitle: 'The Matrix',
		posterUrl: 'https://image.tmdb.org/t/p/w780/poster.jpg',
		releaseYear: 1999
	},
	frames: Array.from({ length: 5 }, (_, index) => ({
		index,
		alt: `Кадр ${index + 1} из загаданного фильма`,
		url: `https://image.tmdb.org/t/p/w1280/f${index}.jpg`
	}))
}
